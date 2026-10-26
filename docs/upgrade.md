# Smart Contract Upgrade Procedure

StellarMarket contracts implement the standard Soroban in-place WASM upgrade pattern gated by an administrative key with a two-step ownership handoff (`transfer_admin` + `accept_admin`).

## 1. Architecture Overview

- **`DataKey::Admin`**: Stored in instance storage during `initialize`. Holds the active administrator `Address` authorized to invoke `upgrade` and `transfer_admin`.
- **`DataKey::PendingAdmin`**: Holds the nominated successor `Address` after `transfer_admin` is called until `accept_admin` is invoked by that successor.
- **`upgrade(new_wasm_hash: BytesN<32>)`**:
  1. Loads `DataKey::Admin` (returning `DisputeError::NotInitialized` if not initialized).
  2. Enforces `admin.require_auth()`.
  3. Calls `env.deployer().update_current_contract_wasm(new_wasm_hash.clone())`.
  4. Extends instance storage TTL and emits `(symbol_short!("dispute"), symbol_short!("upgraded"))` with `ContractUpgraded { new_wasm_hash }`.

## 2. Step-by-Step Upgrade Runbook

### Step 1: Build and Verify the New WASM

```bash
cd contracts
CARGO_BUILD_JOBS=2 cargo test --workspace
stellar contract build --package stellar-market-dispute
```

### Step 2: Upload the New WASM to the Network

Upload the compiled `.wasm` binary to obtain its 32-byte `new_wasm_hash`:

```bash
NEW_WASM_HASH=$(stellar contract install \
  --network testnet \
  --source-account <ADMIN_SECRET_OR_IDENTITY> \
  --wasm target/wasm32-unknown-unknown/release/stellar_market_dispute.wasm)
echo "Uploaded WASM hash: $NEW_WASM_HASH"
```

### Step 3: Execute the In-Place Contract Upgrade

Invoke `upgrade` on the deployed contract instance using the admin account:

```bash
stellar contract invoke \
  --network testnet \
  --id <DISPUTE_CONTRACT_ID> \
  --source-account <ADMIN_SECRET_OR_IDENTITY> \
  -- upgrade \
  --new_wasm_hash "$NEW_WASM_HASH"
```

### Step 4: Verify the `ContractUpgraded` Event

Confirm that the transaction emitted the `("dispute", "upgraded")` event carrying `ContractUpgraded { new_wasm_hash }` and that existing storage entries (`get_admin`, active disputes, arbitrator pool) remain intact.

## 3. Two-Step Admin Rotation (`transfer_admin` / `accept_admin`)

To prevent accidental transfer to an unverified or mistyped address, admin rotation requires two steps:

1. **Current admin nominates the new admin**:
   ```bash
   stellar contract invoke \
     --network testnet \
     --id <DISPUTE_CONTRACT_ID> \
     --source-account <CURRENT_ADMIN> \
     -- transfer_admin \
     --admin <CURRENT_ADMIN_ADDRESS> \
     --new_admin <NEW_ADMIN_ADDRESS>
   ```
   Until step 2 is completed, `<CURRENT_ADMIN_ADDRESS>` remains the active admin.

2. **Pending admin accepts the role**:
   ```bash
   stellar contract invoke \
     --network testnet \
     --id <DISPUTE_CONTRACT_ID> \
     --source-account <NEW_ADMIN> \
     -- accept_admin \
     --pending_admin <NEW_ADMIN_ADDRESS>
   ```
   Once accepted, `DataKey::Admin` is updated to `<NEW_ADMIN_ADDRESS>` and `DataKey::PendingAdmin` is cleared.
