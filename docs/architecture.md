# Arquitetura do Motor de Split — Credit Node

Este documento descreve a visão macro da arquitetura do motor de split de pagamentos (take rate de 2%) operando sobre BaaS (Stark Bank), com foco em escalabilidade, idempotência e consistência financeira.

---

## Visão Geral do Fluxo

1. Cliente final paga uma parcela via Pix (QR Code gerado pela Stark Bank).
2. Stark Bank envia um webhook de confirmação de pagamento.
3. API Gateway (AWS) recebe o webhook e devolve `200 OK` o mais rápido possível.
4. O payload é colocado em uma fila SQS FIFO.
5. Uma função Lambda (Split Processor) consome a fila, garante idempotência no PostgreSQL e calcula o split:
   - Capital + juros → conta do licenciado.
   - 2% do spread → conta da holding.
6. As transferências são disparadas via API da Stark Bank.
7. O ledger é atualizado para `COMPLETED`.
8. Um job de reconciliação trata casos em que o processo fica `PENDING` por falhas de rede/API.

---

## Diagrama Lógico (Texto)

```text
Stark Bank (Webhook Pix)
          │
          ▼
   API Gateway (AWS)
          │
          ▼
      SQS FIFO
          │
          ▼
    Lambda Split Processor
          │
          ├──► PostgreSQL (RDS)
          │       - webhook_events
          │       - split_ledger
          │
          └──► API Stark Bank (Transfers)
                      │
                      └──► Contas:
                             - Licenciado
                             - Holding (2% take rate)

Job de Reconciliação (Lambda agendado)
          ▲
          │
    Lê splits PENDING em
    PostgreSQL e tenta concluir
```

---

## Componentes Principais

### 1. Recebimento de Webhook — API Gateway

- Expõe um endpoint HTTPS para receber webhooks da Stark Bank.
- Responsabilidades:
  - Validar a assinatura (HMAC/RSA) do webhook.
  - Garantir autenticação/autorização básica.
  - Responder `200 OK` rapidamente (para evitar retries desnecessários).
  - Encaminhar o payload bruto para a fila SQS FIFO.

> Importante: a lógica de negócio **não** é executada no API Gateway; ele só faz validações mínimas e repassa para a fila.

---

### 2. SQS FIFO — Fila de Processamento

- Garante durabilidade da mensagem antes de qualquer processamento.
- Usa o `stark_event_id` como `MessageDeduplicationId` para evitar processos duplicados.
- Configurações típicas:
  - Visibility timeout ajustado (ex.: 30 segundos).
  - DLQ (Dead Letter Queue) para mensagens que falham repetidamente.
  - Retenção de mensagens (ex.: 14 dias) para auditoria de incidentes.

Funções principais:

- Desacoplar o recebimento do webhook do processamento de negócio.
- Permitir escalabilidade horizontal automática via Lambda.
- Proteger contra perda de mensagens em caso de falhas momentâneas do sistema.

---

### 3. Lambda — Split Processor

- Função escrita em Node.js/TypeScript.
- Responsabilidades:
  - Ler mensagens da SQS.
  - Interpretar o payload do webhook Pix.
  - Extrair `licensee_id` das tags da transação.
  - Garantir idempotência utilizando o banco PostgreSQL.
  - Registrar o split em estado `PENDING`.
  - Chamar a API da Stark Bank para executar as transferências.
  - Atualizar o ledger para `COMPLETED` após sucesso.

Pontos importantes de implementação:

- Valores monetários tratados como **centavos** (`bigint`/`BIGINT`).
- A API externa (Stark Bank) nunca é chamada dentro de uma transação de banco longa.
- Uso de logs estruturados para rastreabilidade (`stark_event_id`, `licensee_id`, etc.).

---

### 4. Banco de Dados — PostgreSQL (RDS)

- Fonte de verdade financeira.
- Tabelas principais:

1. **`licensees`**
   - Dados dos licenciados (nome, CNPJ/CPF, conta Stark Bank etc.).

2. **`webhook_events`**
   - Registro de cada webhook recebido.
   - Coluna `stark_event_id` com `UNIQUE` para garantir idempotência.
   - Coluna `status`: `PROCESSING`, `COMPLETED`, `FAILED`.

3. **`split_ledger`**
   - Ledger de cada operação de split.
   - Valores em centavos: `total_amount`, `licensee_amount`, `holding_amount`.
   - `CONSTRAINT` garantindo que `licensee_amount + holding_amount = total_amount`.
   - `UNIQUE (webhook_event_id)` para impedir dois splits para o mesmo evento.

Funções do banco:

- Garantir integridade de dados e consistência transacional.
- Servir como trilha de auditoria para operações financeiras.
- Controlar idempotência de forma confiável (independente de cache).

---

### 5. Integração com Stark Bank (Transfers)

- Após registrar o split como `PENDING`, o sistema:
  - Busca o `stark_account_id` do licenciado.
  - Chama a API de transferência da Stark Bank:
    - Transferência 1: capital + juros para o licenciado.
    - Transferência 2: 2% do spread para a holding.
- Cada transferência retorna um `id` da Stark Bank:
  - Armazenado em `split_ledger.stark_transfer_licensee_id`.
  - Armazenado em `split_ledger.stark_transfer_holding_id`.

> Em caso de falha em qualquer uma das transferências, o split permanece `PENDING` para reconciliação posterior.

---

### 6. Job de Reconciliação

- Implementado como outra função Lambda, disparada periodicamente (ex.: a cada 5 minutos) via EventBridge.
- Responsabilidades:
  - Buscar registros em `split_ledger` com `status = 'PENDING'` e `created_at` antigo (ex.: > 2 minutos).
  - Tentar completar as operações (chamando novamente a Stark Bank, se necessário).
  - Atualizar o status para `COMPLETED` ou, conforme política, `FAILED`.

Benefícios:

- Evita dinheiro “no limbo” em caso de queda da API da Stark Bank.
- Garante consistência eventual do sistema.
- Permite observabilidade via logs/alertas quando muitos splits permanecem em `PENDING`.

---

## Idempotência de Webhooks

Problema: a Stark Bank pode reenviar o mesmo webhook em caso de timeout ou falhas de rede.

Solução:

- O `stark_event_id` é usado como chave de idempotência:
  - Primeiro passo no processamento é tentar:
    ```sql
    INSERT INTO webhook_events (stark_event_id, status, payload)
    VALUES (...)
    ON CONFLICT (stark_event_id) DO NOTHING
    ```
  - Se o `INSERT` retornar `rowCount = 0`, significa que o evento já foi registrado → o processamento é interrompido com segurança, sem novo split.
- A tabela `split_ledger` ainda reforça isso com `UNIQUE (webhook_event_id)`.

---

## Escalabilidade

Para suportar 100.000 transações simultâneas:

- SQS absorve picos de tráfego sem perda de mensagens.
- Lambda escala horizontalmente, consumindo a fila em paralelo.
- RDS Proxy é utilizado entre Lambda e PostgreSQL para gerenciar conexões, evitando exaustão de conexões do banco.
- Limites de concorrência configurados na Lambda para controlar pressão sobre o banco.

---

## Segurança e Boas Práticas

- Validação de assinatura dos webhooks (HMAC/RSA) na borda (API Gateway ou Lambda inicial).
- Uso de HTTPS/TLS em todos os canais externos.
- Segredos (tokens da Stark Bank, connection strings) gerenciados via AWS Secrets Manager ou SSM Parameter Store.
- Logs estruturados contendo IDs de correlação (`stark_event_id`, `licensee_id`) para facilitar auditoria.
- Nenhum uso de `float` ou `double` para valores monetários, apenas inteiros em centavos.

---

## Conclusão

A arquitetura foi desenhada para:

- Garantir que cada pagamento Pix resulte em **no máximo um split**.
- Manter um ledger financeiro rastreável e auditável.
- Ser resiliente a falhas de rede/API sem deixar dinheiro “preso”.
- Escalar para dezenas ou centenas de milhares de transações com segurança.

A implementação concreta dessa lógica está nos arquivos:

- `src/handlers/split-processor.ts`
- `src/jobs/reconciliation.ts`
- `database/migrations/001_initial_schema.sql`