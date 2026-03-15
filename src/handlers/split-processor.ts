// src/handlers/split-processor.ts

import { SQSEvent, SQSRecord } from 'aws-lambda';
import { Pool, PoolClient } from 'pg';
// import starkbank from 'starkbank'; // descomentar e configurar quando integrar de fato

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const HOLDING_RATE = 0.02; // 2% — taxa da holding

// ─────────────────── Tipos ──────────────────────

interface StarkPixWebhook {
  event: {
    id: string;           // chave de idempotência (stark_event_id)
    type: string;
    log: {
      pixRequest: {
        id: string;
        amount: number;   // em centavos
        tags: string[];
        description?: string;
      };
    };
  };
}

interface SplitCalculation {
  totalAmount: bigint;
  holdingAmount: bigint;
  licenseeAmount: bigint;
}

// ─────────────────── Handler principal (Lambda) ──────────────────────

export const handler = async (event: SQSEvent): Promise<void> => {
  for (const record of event.Records) {
    await processSingleWebhook(record);
  }
};

// ─────────────────── Processamento individual ──────────────────────

async function processSingleWebhook(record: SQSRecord): Promise<void> {
  const payload: StarkPixWebhook = JSON.parse(record.body);
  const { event } = payload;
  const pixRequest = event.log.pixRequest;
  const starkEventId = event.id;

  // Em produção, recomenda-se validar assinatura/HMAC aqui
  // validateStarkSignatureIfForwarded(record);

  const licenseeId = extractLicenseeId(pixRequest.tags);
  if (!licenseeId) {
    throw new Error(`licensee_id ausente nas tags do PixRequest ${pixRequest.id}`);
  }

  const split = calculateSplit(BigInt(pixRequest.amount));

  await executeWithIdempotency(starkEventId, licenseeId, split, pixRequest.id);
}

// ─────────────────── Cálculo do split (2% holding) ──────────────────────

function calculateSplit(totalCents: bigint): SplitCalculation {
  // Usando BigInt para evitar problemas de ponto flutuante
  const holdingAmount = (totalCents * 2n) / 100n; // 2%
  const licenseeAmount = totalCents - holdingAmount;

  return { totalAmount: totalCents, holdingAmount, licenseeAmount };
}

// ─────────────────── Execução com idempotência + transação ──────────────────────

async function executeWithIdempotency(
  starkEventId: string,
  licenseeId: string,
  split: SplitCalculation,
  pixRequestId: string
): Promise<void> {
  const client: PoolClient = await db.connect();

  try {
    await client.query('BEGIN');

    // Guarda de idempotência — tenta registrar o evento
    const insertResult = await client.query<{ id: string }>(
      `
      INSERT INTO webhook_events (stark_event_id, status, payload)
      VALUES ($1, 'PROCESSING', $2)
      ON CONFLICT (stark_event_id) DO NOTHING
      RETURNING id
    `,
      [starkEventId, JSON.stringify({ pixRequestId, licenseeId })],
    );

    if (insertResult.rowCount === 0) {
      // Evento já foi inserido antes → duplicado, não processa de novo
      console.warn(`[IDEMPOTENCY] Evento duplicado ignorado: ${starkEventId}`);
      await client.query('ROLLBACK');
      return;
    }

    const webhookEventId = insertResult.rows[0].id;

    // Registra o split como PENDING no ledger
    await client.query(
      `
      INSERT INTO split_ledger
        (webhook_event_id, licensee_id, total_amount, licensee_amount, holding_amount, status)
      VALUES ($1, $2, $3, $4, $5, 'PENDING')
    `,
      [
        webhookEventId,
        licenseeId,
        split.totalAmount.toString(),
        split.licenseeAmount.toString(),
        split.holdingAmount.toString(),
      ],
    );

    // Commit antes de falar com qualquer API externa
    await client.query('COMMIT');

    // ─── Chamadas à API da Stark Bank (mockadas aqui) ───
    // Em uma integração real, você chamaria a SDK da Stark Bank neste ponto.
    // Exemplo conceitual:
    //
    // const licenseeAccountId = await getLicenseeAccountId(licenseeId);
    // const licenseeTransfer = await dispatchTransfer({
    //   targetAccountId: licenseeAccountId,
    //   amount: split.licenseeAmount,
    //   description: `Liquidação Pix ${pixRequestId} — Capital + Juros`,
    // });
    // const holdingTransfer = await dispatchTransfer({
    //   targetAccountId: process.env.HOLDING_ACCOUNT_ID!,
    //   amount: split.holdingAmount,
    //   description: `Take Rate 2% — Pix ${pixRequestId}`,
    // });

    const mockLicenseeTransferId = `mock-licensee-transfer-${starkEventId}`;
    const mockHoldingTransferId = `mock-holding-transfer-${starkEventId}`;

    // Atualiza ledger + evento para COMPLETED
    await client.query('BEGIN');

    await client.query(
      `
      UPDATE split_ledger
      SET
        stark_transfer_licensee_id = $1,
        stark_transfer_holding_id  = $2,
        status = 'COMPLETED'
      WHERE webhook_event_id = $3
    `,
      [mockLicenseeTransferId, mockHoldingTransferId, webhookEventId],
    );

    await client.query(
      `
      UPDATE webhook_events
      SET status = 'COMPLETED', processed_at = NOW()
      WHERE id = $1
    `,
      [webhookEventId],
    );

    await client.query('COMMIT');

    console.info(
      `[SPLIT OK] Evento ${starkEventId} processado. ` +
        `licenseeId=${licenseeId} total=${split.totalAmount.toString()}`,
    );
  } catch (err) {
    await client.query('ROLLBACK');
    await markEventAsFailed(starkEventId, err);
    throw err;
  } finally {
    client.release();
  }
}

// ─────────────────── Helpers ──────────────────────

function extractLicenseeId(tags: string[]): string | null {
  const tag = tags.find((t) => t.startsWith('licensee:'));
  return tag ? tag.split(':')[1] : null;
}

async function markEventAsFailed(starkEventId: string, error: unknown): Promise<void> {
  await db.query(
    `
    UPDATE webhook_events
    SET status = 'FAILED'
    WHERE stark_event_id = $1
  `,
    [starkEventId],
  );
  console.error(`[SPLIT FAILED] ${starkEventId}`, error);
}

// Exemplo de stub de função para buscar conta do licenciado
// async function getLicenseeAccountId(licenseeId: string): Promise<string> {
//   const result = await db.query(
//     'SELECT stark_account_id FROM licensees WHERE id = $1',
//     [licenseeId],
//   );
//   if (!result.rows[0]) throw new Error(`Licenciado não encontrado: ${licenseeId}`);
//   return result.rows[0].stark_account_id;
// }

// Exemplo de stub de dispatch de transferência
// async function dispatchTransfer(params: {
//   targetAccountId: string;
//   amount: bigint;
//   description: string;
// }): Promise<{ id: string }> {
//   // Aqui você chamaria a API da Stark Bank
//   // Este stub devolve um ID mockado
//   return { id: `mock-transfer-${Date.now()}` };
// }