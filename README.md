# Credit Node — Split Engine

Motor de monetização invisível para um ecossistema de crédito autônomo operando sobre infraestrutura BaaS (Stark Bank).

Quando um cliente final paga uma parcela via Pix (QR Code Stark Bank), este motor:
- Recebe o webhook de confirmação de pagamento.
- Aplica split automático do valor.
- Envia capital + juros ao licenciado.
- Retém 2% do spread para a holding, como taxa de liquidação.

---

## Visão Geral

Este repositório descreve a arquitetura, a lógica de negócio e o fluxo transacional do motor de split, com foco em:

- Segurança financeira (idempotência, integridade, rastreabilidade).
- Escalabilidade (100.000 transações simultâneas).
- Resiliência a falhas de rede e da API da Stark Bank.
- Evitar qualquer duplicidade de split em caso de reenvio de webhooks.

---

## Arquitetura em Alto Nível

Componentes principais:

- **Stark Bank**  
  Origem dos webhooks Pix pagos.

- **API Gateway (AWS)**  
  - Recebe os webhooks HTTPS da Stark Bank.
  - Valida assinatura/HMAC.
  - Devolve `200 OK` o mais rápido possível.

- **SQS FIFO (AWS)**  
  - Garante que o webhook seja armazenado de forma durável antes do processamento.
  - Usa o `stark_event_id` como chave de deduplicação.
  - Possui DLQ para mensagens com erro recorrente.

- **Lambda (AWS) — Split Processor**  
  - Lê mensagens da fila SQS.
  - Garante idempotência em nível de banco (PostgreSQL).
  - Calcula o split (2% holding, restante licenciado).
  - Dispara as transferências via API Stark Bank.
  - Atualiza o status das operações no banco (ledger).

- **PostgreSQL (RDS Multi-AZ + RDS Proxy)**  
  - Tabela de eventos de webhook (controle de idempotência).
  - Tabela de ledger de splits (rastreamento contábil).
  - Tudo em valores inteiros (centavos), sem uso de `float`.

- **Job de Reconciliação (EventBridge + Lambda)**  
  - Varre splits em estado `PENDING`.
  - Reexecuta transferências em caso de falha parcial ou queda da API.
  - Garante consistência eventual sem dinheiro “no limbo”.

Mais detalhes em: `docs/architecture.md`.

---

## Idempotência

Instituições financeiras podem reenviar o mesmo webhook Pix mais de uma vez (timeout, falha de rede, etc.).

A idempotência é garantida por:

- Tabela `webhook_events` com coluna `stark_event_id` **única**.
- Primeira ação do código ao receber o evento: tentar `INSERT` com esse ID.
  - Se o `INSERT` falhar por `UNIQUE VIOLATION`, o evento já foi recebido → ignorar com segurança (sem novo split).
  - Se o `INSERT` funcionar, o evento é processado pela primeira vez.
- Ledger de splits (`split_ledger`) amarra cada split a um único `webhook_event_id`.

Mais detalhes em: `docs/architecture.md` e `database/migrations/001_initial_schema.sql`.

---

## Lógica do Split (2% Holding)

- Valores sempre em **centavos** (`BIGINT`/`bigint`).
- Fórmula:
  - `holdingAmount = floor(totalAmount * 2 / 100)`
  - `licenseeAmount = totalAmount - holdingAmount`
- A soma de `holdingAmount + licenseeAmount` é sempre igual ao valor total.

Implementação em TypeScript no arquivo:

- `src/handlers/split-processor.ts`

---

## Fluxo de Processamento

1. Stark Bank envia webhook Pix pago.
2. API Gateway recebe, valida assinatura e retorna `200 OK`.
3. Payload é colocado na fila SQS FIFO.
4. Lambda consome SQS e:
   - Garante idempotência no PostgreSQL.
   - Registra o split em estado `PENDING`.
   - Chama a API da Stark Bank para:
     - Transferir capital + juros ao licenciado.
     - Transferir 2% do spread à holding.
   - Atualiza o ledger para `COMPLETED` após confirmação das transferências.
5. Em caso de falha parcial (ex.: uma transferência ok, outra não):
   - O registro permanece `PENDING`.
   - O job de reconciliação tenta novamente.

---

## Plano de Contingência

Se a API da Stark Bank cair no meio do processo:

- O banco de dados já terá um registro `PENDING` com:
  - Valor total da operação.
  - Valor calculado para licenciado.
  - Valor calculado para holding.
- Nenhuma mudança de status para `COMPLETED` é realizada antes do sucesso das duas transferências.
- Um job de reconciliação (Lambda agendada) reprocessa registros `PENDING` mais antigos.
- Não há duplicidade, pois:
  - O `stark_event_id` continua único.
  - O split continua vinculado a um único evento.

---

## Stack Técnica (Proposta)

- **Linguagem:** Node.js / TypeScript
- **Infra:** AWS (API Gateway, SQS FIFO, Lambda, EventBridge)
- **Banco de Dados:** PostgreSQL (RDS Multi-AZ + RDS Proxy)
- **BaaS:** Stark Bank (webhooks Pix + transfers)
- **Mensageria:** SQS FIFO + DLQ

---

## Estrutura de Arquivos (Sugerida)

```text
.
├── README.md
├── docs/
│   └── architecture.md
├── database/
│   └── migrations/
│       └── 001_initial_schema.sql
└── src/
    ├── handlers/
    │   └── split-processor.ts
    └── jobs/
        └── reconciliation.ts
```

---

## Próximos Passos

- Implementar infraestrutura como código (CDK/Terraform).
- Integrar logs estruturados e métricas (CloudWatch, X-Ray).
- Adicionar testes unitários e de integração no motor de split.