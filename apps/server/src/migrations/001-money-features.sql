-- Red Packets Table
CREATE TABLE IF NOT EXISTS red_packets (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN (normal, lucky)),
    total_amount INTEGER NOT NULL,
    total_count INTEGER NOT NULL,
    remaining INTEGER NOT NULL,
    remain_count INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN (active, exhausted, expired)),
    message TEXT,
    created_at TEXT NOT NULL,
    expired_at TEXT
);

CREATE INDEX idx_red_packets_session ON red_packets(session_id);
CREATE INDEX idx_red_packets_sender ON red_packets(sender_id);
CREATE INDEX idx_red_packets_status ON red_packets(status);

-- Red Packet Records Table
CREATE TABLE IF NOT EXISTS red_packet_records (
    id TEXT PRIMARY KEY,
    red_packet_id TEXT NOT NULL,
    claimer_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    claimed_at TEXT NOT NULL,
    FOREIGN KEY (red_packet_id) REFERENCES red_packets(id)
);

CREATE INDEX idx_red_packet_records_pkt ON red_packet_records(red_packet_id);
CREATE INDEX idx_red_packet_records_claimer ON red_packet_records(claimer_id);

-- AA Bills Table
CREATE TABLE IF NOT EXISTS aa_bills (
    id TEXT PRIMARY KEY,
    creator_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    description TEXT NOT NULL,
    total_amount INTEGER NOT NULL,
    settled_amount INTEGER NOT NULL DEFAULT 0,
    participant_ids TEXT NOT NULL,
    split_type TEXT NOT NULL CHECK(split_type IN (equal, custom)),
    custom_splits TEXT,
    deadline TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN (pending, settled, cancelled)),
    created_at TEXT NOT NULL
);

CREATE INDEX idx_aa_bills_session ON aa_bills(session_id);
CREATE INDEX idx_aa_bills_status ON aa_bills(status);
CREATE INDEX idx_aa_bills_deadline ON aa_bills(deadline);

-- AA Payments Table
CREATE TABLE IF NOT EXISTS aa_payments (
    id TEXT PRIMARY KEY,
    bill_id TEXT NOT NULL,
    payer_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    paid_at TEXT NOT NULL,
    FOREIGN KEY (bill_id) REFERENCES aa_bills(id)
);

CREATE INDEX idx_aa_payments_bill ON aa_payments(bill_id);
CREATE INDEX idx_aa_payments_payer ON aa_payments(payer_id);

-- Transfers Table
CREATE TABLE IF NOT EXISTS transfers (
    id TEXT PRIMARY KEY,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    message TEXT,
    state TEXT NOT NULL CHECK(state IN (pending, accepted, rejected, refunded)),
    created_at TEXT NOT NULL,
    expired_at TEXT NOT NULL
);

CREATE INDEX idx_transfers_from ON transfers(from_id);
CREATE INDEX idx_transfers_to ON transfers(to_id);
CREATE INDEX idx_transfers_state ON transfers(state);
CREATE INDEX idx_transfers_expired ON transfers(expired_at);
