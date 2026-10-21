import {Migration} from "@mikro-orm/migrations";

export class Migration20261021104500 extends Migration {

    async up(): Promise<void> {
        this.addSql('CREATE TABLE wallets (\n' +
            '  id          uuid PRIMARY KEY,\n' +
            '  player_id   uuid NOT NULL,\n' +
            '  currency    char(3) NOT NULL CHECK (currency ~ \'^[A-Z]{3}$\'),\n' +
            '  balance     numeric(19,2) NOT NULL CHECK (balance >= 0),\n' +
            '  version     integer NOT NULL DEFAULT 1 CHECK (version >= 1),\n' +
            '  created_at  timestamptz NOT NULL,\n' +
            '  updated_at  timestamptz NOT NULL,\n' +
            '  UNIQUE (player_id, currency)\n' +
            ');');
        this.addSql('CREATE TABLE wager_transactions (\n' +
            '  id                                 uuid PRIMARY KEY,\n' +
            '  provider_id                        text NOT NULL,\n' +
            '  external_transaction_id            text NOT NULL,\n' +
            '  idempotency_key                    text NOT NULL,\n' +
            '  payload_hash                       char(64) NOT NULL,\n' +
            '  wallet_id                          uuid NOT NULL REFERENCES wallets(id),\n' +
            '  player_id                          uuid NOT NULL,\n' +
            '  round_id                           text NOT NULL,\n' +
            '  game_id                            text NOT NULL,\n' +
            '  kind                               text NOT NULL CHECK (kind IN (\'BET\',\'WIN\',\'LOSS\',\'REFUND\',\'ROLLBACK\',\'OPENING\')),\n' +
            '  amount                             numeric(19,2) NOT NULL,\n' +
            '  currency                           char(3) NOT NULL,\n' +
            '  reference_external_transaction_id  text,\n' +
            '  reference_transaction_id           uuid REFERENCES wager_transactions(id),\n' +
            '  status                             text NOT NULL CHECK (status IN (\'PENDING\',\'PENDING_REFERENCE\',\'PROCESSED\',\'REJECTED\',\'FAILED\')),\n' +
            '  failure_code                       text,\n' +
            '  balance_after                      numeric(19,2),       -- balance observed at the end of processing, for replays (§7 rule 7)\n' +
            '  attempts                           integer NOT NULL DEFAULT 0,\n' +
            '  next_attempt_at                    timestamptz,\n' +
            '  created_at                         timestamptz NOT NULL,\n' +
            '  processed_at                       timestamptz,\n' +
            '  UNIQUE (provider_id, external_transaction_id),\n' +
            '  UNIQUE (provider_id, idempotency_key),\n' +
            '  CHECK (amount > 0 OR kind = \'LOSS\'),\n' +
            '  CHECK ((status IN (\'REJECTED\',\'FAILED\')) = (failure_code IS NOT NULL)),\n' +
            '  CHECK ((status = \'PROCESSED\') = (processed_at IS NOT NULL)),\n' +
            '  CHECK (CASE WHEN kind IN (\'REFUND\',\'ROLLBACK\') THEN reference_external_transaction_id IS NOT NULL\n' +
            '              WHEN kind IN (\'BET\',\'OPENING\')     THEN reference_external_transaction_id IS NULL\n' +
            '              ELSE true END)\n' +
            ');');
        this.addSql('CREATE UNIQUE INDEX wager_one_reversal ON wager_transactions (reference_transaction_id)\n' +
            '  WHERE status = \'PROCESSED\' AND kind IN (\'REFUND\',\'ROLLBACK\');\n' +
            'CREATE INDEX wager_pending_reference_due ON wager_transactions (next_attempt_at)\n' +
            '  WHERE status = \'PENDING_REFERENCE\';\n' +
            'CREATE INDEX wager_by_wallet ON wager_transactions (wallet_id, created_at);\n');
        this.addSql('CREATE TABLE wallet_ledger_entries (\n' +
            '  seq            bigint GENERATED ALWAYS AS IDENTITY UNIQUE,   -- cursor for pagination\n' +
            '  id             uuid PRIMARY KEY,\n' +
            '  wallet_id      uuid NOT NULL REFERENCES wallets(id),\n' +
            '  transaction_id uuid NOT NULL UNIQUE REFERENCES wager_transactions(id),\n' +
            '  direction      text NOT NULL CHECK (direction IN (\'DEBIT\',\'CREDIT\')),\n' +
            '  amount         numeric(19,2) NOT NULL CHECK (amount > 0),\n' +
            '  currency       char(3) NOT NULL,\n' +
            '  balance_before numeric(19,2) NOT NULL CHECK (balance_before >= 0),\n' +
            '  balance_after  numeric(19,2) NOT NULL CHECK (balance_after >= 0),\n' +
            '  created_at     timestamptz NOT NULL,\n' +
            '  CHECK ((direction = \'CREDIT\' AND balance_after = balance_before + amount)\n' +
            '      OR (direction = \'DEBIT\'  AND balance_after = balance_before - amount))\n' +
            ');');
        this.addSql('CREATE INDEX ledger_by_wallet ON wallet_ledger_entries (wallet_id, seq);\n' +
            'CREATE FUNCTION ledger_is_append_only() RETURNS trigger LANGUAGE plpgsql AS\n' +
            '  $$ BEGIN RAISE EXCEPTION \'wallet_ledger_entries is append-only\'; END $$;\n' +
            'CREATE TRIGGER ledger_no_update_delete BEFORE UPDATE OR DELETE ON wallet_ledger_entries\n' +
            '  FOR EACH ROW EXECUTE FUNCTION ledger_is_append_only();')
        this.addSql('CREATE TABLE inbox_messages (\n' +
            '  consumer_name text NOT NULL,\n' +
            '  message_id    text NOT NULL,\n' +
            '  payload_hash  char(64) NOT NULL,\n' +
            '  received_at   timestamptz NOT NULL,\n' +
            '  processed_at  timestamptz,\n' +
            '  PRIMARY KEY (consumer_name, message_id)\n' +
            ');');
        this.addSql('CREATE TABLE outbox_messages (\n' +
            '  id              uuid PRIMARY KEY,            -- the event id\n' +
            '  aggregate_id    uuid NOT NULL,\n' +
            '  event_type      text NOT NULL,\n' +
            '  payload         jsonb NOT NULL,\n' +
            '  occurred_at     timestamptz NOT NULL,\n' +
            '  attempts        integer NOT NULL DEFAULT 0,\n' +
            '  next_attempt_at timestamptz NOT NULL,\n' +
            '  published_at    timestamptz\n' +
            ');');
        this.addSql('CREATE INDEX outbox_due ON outbox_messages (next_attempt_at) WHERE published_at IS NULL;');
    }

    async down(): Promise<void> {
        this.addSql('DROP TABLE IF EXISTS outbox_messages;');
        this.addSql('DROP TABLE IF EXISTS inbox_messages;');
        this.addSql('DROP TABLE IF EXISTS wallet_ledger_entries;');   // drops its trigger and indexes with it
        this.addSql('DROP FUNCTION IF EXISTS ledger_is_append_only();');
        this.addSql('DROP TABLE IF EXISTS wager_transactions;');
        this.addSql('DROP TABLE IF EXISTS wallets;');
    }

}