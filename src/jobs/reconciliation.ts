// src/jobs/reconciliation.ts

import { Pool, PoolClient } from 'pg';
// import starkbank from 'starkbank'; // integrar quando for usar a API real

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
});

interface PendingSplit {
  id: string;
  webhook_event_id: string;
  licensee_id: string;
  total_amount: bigint;
  licensee_amount: bigint;
  holding_amount: bigint;
}

/**
 * Handler do job de reconciliação.
 * Ideia: agendar via EventBridge para rodar, por exemplo, a cada 5 minutos.
 */
export const handler = async (): Promise<void> => {
  const client: PoolClient = await db.connect();

  try {
    await client.query('BEGIN');

    // Seleciona splits PENDING "antigos" para reprocessamento.
    // O SKIP LOCKED garante que múltiplas instâncias não peguem o mesmo registro.
    const result = await client.query<PendingSplit>(
      `
      SELECT
        sl.id,
        sl.webhook_event_id,
        sl.licensee_id,
        sl.total_amount,
        sl.licensee_amount,
        sl.holding_amount
      FROM split_ledger sl
      WHERE sl.status = 'PENDING'
        AND sl.created_at < NOW() - INTERVAL '2 minutes'
      FOR UPDATE SKIP LOCKED
      LIMIT 50
      `,
    );

    const pendingSplits = result.rows;

    if (pendingSplits.length === 0) {
      console.info('[RECONCILIATION] Nenhum split PENDING encontrado.');
      await client.query('COMMIT');
      return;
    }

    console.info(`[RECONCILIATION] Encontrados ${pendingSplits.length} splits PENDING.`);

    await client.query('COMMIT'); // libera o lock antes de reprocessar um a um

    // Reprocessa cada split individualmente (fora da transação principal)
    for (const split of pendingSplits) {
      await reconcileSingleSplit(split);
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[RECONCILIATION] Falha ao listar splits PENDING', err);
    throw err;
  } finally {
    client.release();
  }
};

/**
 * Reprocessa um split específico em estado PENDING:
 * - Tenta novamente as transferências (mock / ou Stark Bank real).
 * - Atualiza o status para COMPLETED em caso de sucesso.
 */
async function reconcileSingleSplit(split: PendingSplit): Promise<void> {
  const client: PoolClient = await db.connect();

  try {
    console.info(
      `[RECONCILIATION] Reprocessando split ${split.id} (webhook_event_id=${split.webhook_event_id})`,
    );

    // Em produção, você verificaria se alguma transferência já foi feita na Stark Bank
    // antes de criar novas, usando o ID de correlação ou metadata.
    //
    // Aqui, vamos fazer mock das transferências novamente.

    const mockLicenseeTransferId = `recon-licensee-${split.webhook_event_id}`;
    const mockHoldingTransferId = `recon-holding-${split.webhook_event_id}`;

    await client.query('BEGIN');

    await client.query(
      `
      UPDATE split_ledger
      SET
        stark_transfer_licensee_id = $1,
        stark_transfer_holding_id  = $2,
        status = 'COMPLETED',
        updated_at = NOW()
      WHERE id = $3
        AND status = 'PENDING'
      `,
      [mockLicenseeTransferId, mockHoldingTransferId, split.id],
    );

    await client.query(
      `
      UPDATE webhook_events
      SET status = 'COMPLETED', processed_at = NOW()
      WHERE id = $1
      `,
      [split.webhook_event_id],
    );

    await client.query('COMMIT');

    console.info(
      `[RECONCILIATION] Split ${split.id} reconciliado com sucesso (COMPLETED).`,
    );
  } catch (err) {
    await client.query('ROLLBACK');

    console.error(
      `[RECONCILIATION] Falha ao reconciliar split ${split.id} (webhook_event_id=${split.webhook_event_id})`,
      err,
    );

    // Em caso de falha recorrente, você pode:
    // - Marcar como FAILED, ou
    // - Deixar em PENDING para uma próxima tentativa, conforme estratégia de negócio.
  } finally {
    client.release();
  }
}