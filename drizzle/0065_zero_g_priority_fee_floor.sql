-- Raise the priority-fee floor for both 0G chains -- Galileo testnet (16602)
-- and Mainnet (16661) -- to match the networks' tip-cap minimum of 2 gwei.
-- Galileo rejects submissions below 2 gwei with "gas tip cap below minimum
-- (needed 2 gwei)". Mainnet shares the same RPC fingerprint (zero base fee,
-- eth_maxPriorityFeePerGas = 4 gwei suggestion, sparse block rewards), so it
-- almost certainly enforces the same floor.
--
-- The application gas strategy in lib/web3/gas-strategy.ts (see getChainConfig)
-- merges layers in this order:
--   ...defaultConfig
--   ...getHardcodedOverrides(chainId)
--   ...dbConfig
-- so an empty gas_config = {} is harmless (hardcoded wins) but a populated
-- gas_config overrides the hardcoded floor. This migration writes the values
-- into the DB so the canonical chains.gas_config column matches the hardcoded
-- entries committed alongside it -- the design intent set by 0013_chain-gas-config.
--
-- Idempotent: jsonb concatenation overwrites same keys on re-run, the
-- WHERE clause limits scope to the two 0G chains, and COALESCE handles the
-- NULL case for environments that pre-date the column's '{}' default.

UPDATE "chains"
   SET "gas_config" = COALESCE("gas_config", '{}'::jsonb)
                      || '{"minPriorityFeeGwei": 2.0, "maxPriorityFeeGwei": 500, "gasLimitMultiplier": 2.0}'::jsonb,
       "updated_at" = now()
 WHERE "chain_id" IN (16602, 16661);
