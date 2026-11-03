ALTER TABLE "ledger_proposals" DROP CONSTRAINT "ledger_proposals_kind_check";
ALTER TABLE "ledger_proposals" ADD CONSTRAINT "ledger_proposals_kind_check" CHECK ("kind" in ('taxonomy', 'mapping', 'measurement'));
