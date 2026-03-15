-- ─────────────────────────────────────────────────────────────────
-- 001_initial_schema.sql
-- Schema inicial do Credit Node Split Engine
-- Todos os valores monetários em centavos (BIGINT) — nunca float
-- ─────────────────────────────────────────────────────────────────

-- ─── Extensões ───────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- para gen_random_uuid()

-- ─── Tabela de Licenciados ────────────────────────────────────────
-- Armazena os licenciados que operam crédito na plataforma

CREATE TABLE licensees (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                VARCHAR(255)    NOT NULL,
    tax_id              VARCHAR(20)     NOT NULL UNIQUE, -- CPF ou CNPJ
    stark_account_id    VARCHAR(255)    NOT NULL UNIQUE, -- ID da conta na Stark Bank
    active              BOOLEAN         NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_licensees_stark_account ON licensees(stark_account_id);

-- ─── Tabela de Controle de Idempotência ──────────────────────────
-- Garante que cada webhook da Stark Bank seja processado uma única vez

CREATE TABLE webhook_events (
    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    stark_event_id  VARCHAR(255)    NOT NULL UNIQUE, -- chave de idempotência
    status          VARCHAR(50)     NOT NULL DEFAULT 'PROCESSING',
    -- Valores possíveis: PROCESSING | COMPLETED | FAILED
    payload         JSONB           NOT NULL,
    processed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_stark_event_id
    ON webhook_events(stark_event_id);

CREATE INDEX idx_webhook_events_status
    ON webhook_events(status);

CREATE INDEX idx_webhook_events_created_at
    ON webhook_events(created_at);

-- ─── Tabela de Ledger de Splits ───────────────────────────────────
-- Registro contábil de cada split executado

CREATE TABLE split_ledger (
    id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    webhook_event_id            UUID        NOT NULL REFERENCES webhook_events(id),
    licensee_id                 UUID        NOT NULL REFERENCES licensees(id),

    -- Valores em centavos (BIGINT) — nunca float
    total_amount                BIGINT      NOT NULL CHECK (total_amount > 0),
    licensee_amount             BIGINT      NOT NULL CHECK (licensee_amount > 0),
    holding_amount              BIGINT      NOT NULL CHECK (holding_amount > 0),

    -- IDs das transferências geradas na Stark Bank
    stark_transfer_licensee_id  VARCHAR(255),
    stark_transfer_holding_id   VARCHAR(255),

    status                      VARCHAR(50) NOT NULL DEFAULT 'PENDING',
    -- Valores possíveis: PENDING | COMPLETED | FAILED

    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Garante que um evento nunca gere dois splits
    CONSTRAINT no_duplicate_split UNIQUE (webhook_event_id)
);

CREATE INDEX idx_split_ledger_status
    ON split_ledger(status);

CREATE INDEX idx_split_ledger_licensee
    ON split_ledger(licensee_id);

CREATE INDEX idx_split_ledger_created_at
    ON split_ledger(created_at);

-- ─── Constraint de integridade financeira ────────────────────────
-- Garante que licensee_amount + holding_amount = total_amount

ALTER TABLE split_ledger
    ADD CONSTRAINT check_split_sum
    CHECK (licensee_amount + holding_amount = total_amount);

-- ─── Trigger: updated_at automático ──────────────────────────────

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_licensees_updated_at
    BEFORE UPDATE ON licensees
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_split_ledger_updated_at
    BEFORE UPDATE ON split_ledger
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── Dados iniciais (opcional para testes) ────────────────────────

-- INSERT INTO licensees (name, tax_id, stark_account_id)
-- VALUES ('Licenciado Exemplo', '00.000.000/0001-00', 'stark-account-id-aqui');