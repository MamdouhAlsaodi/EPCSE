# Establishment operations (SC-20)

Firm commands are scheduled engine commands and take effect in the command phase of their requested tick. The owner ID in the payload must match the live firm owner; build also checks live owner/account and recipe identities. Rejected commands are applied to a command draft, so they do not partially mutate domain state.

- `firm.build` creates an active producer with its own firm ID, owner, account, city, recipe and operating settings. Its configured capacity is charged at the configured expansion cost to the construction provider before the firm and producer are inserted. The new producer participates in the same tick's production phase. Accounts, owners, recipes, workforce configuration and opening stock must already be configured; this command does not create or fund those resources.
- `firm.upgrade` adds bounded capacity and charges the owner-controlled firm account at the same configured per-capacity rate as expansion.
- `firm.administration` sets the firm's nonnegative `wagePerBatch`. The producer uses the new wage in production and accounting from that tick onward; it is not a cosmetic setting.
- `firm.price` replaces the min/max/opening/reference price for the selected commodity's seller record(s) tied to that firm's owner and account. The market quote phase on that tick honors the new bounds; other sellers are untouched.
- `firm.relocation.propose` records the requesting owner, destination identifier and submission tick. It is proposal metadata only: no city, inventory ownership or stock location, workforce, route or production field is changed by this command. Physical relocation is deliberately out of scope until location, cost, downtime and ownership-transfer policy are approved.

`firm.expand` and `firm.close` retain their existing behavior. Construction payments are ledger payments, not minting; existing accounting invariants preserve currency conservation. Snapshots retain firm and economy operation state and require the same registered base configuration when restored.
