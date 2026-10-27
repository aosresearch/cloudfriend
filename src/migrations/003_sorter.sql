-- The multi-workspace sorter (worker.ts). Delivery is one pool shared by every worker and every
-- workspace, so its claim looks for the earliest due deliveries of any workspace: the index from
-- 001 leads with workspace_id and can't serve that order.
CREATE INDEX deliveries_due_any ON deliveries (next_attempt_at) WHERE status = 'pending';
