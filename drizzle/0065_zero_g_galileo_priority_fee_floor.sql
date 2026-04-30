-- Raise the priority-fee floor for 0G Galileo testnet (chainId 16602) to match
-- the network's mempool requirement of 2 gwei. Submissions below 2 gwei are
-- rejected with "gas tip cap below minimum (needed 2 gwei)".
--
-- The application gas strategy reads chains.gas_config and merges it OVER the
-- hardcoded overrides at lib/web3/gas-strategy.ts:463-468:
--   ...defaultConfig
--   ...getHardcodedOverrides(chainId)
--   ...dbConfig
-- so an empty gas_config = {} is harmless (hardcoded wins), but an explicit
-- gas_config with a stale low minPriorityFeeGwei would override the new
-- hardcoded floor. This migration patches the DB row to be consistent with
-- the hardcoded values committed alongside it.
--
-- Idempotent: jsonb concatenation overwrites the same keys on re-run; the
-- WHERE clause limits scope to chain 16602.

UPDATE "chains"
   SET "gas_config" = COALESCE("gas_config", '{}'::jsonb)
                      || '{"minPriorityFeeGwei": 2.0, "maxPriorityFeeGwei": 500, "gasLimitMultiplier": 2.0}'::jsonb,
       "updated_at" = now()
 WHERE "chain_id" = 16602;
