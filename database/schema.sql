-- Just 4 fields. That's all we need.
CREATE TABLE IF NOT EXISTS monitored_contacts (
    contact_id TEXT PRIMARY KEY,           -- GHL contact ID
    phone_number TEXT NOT NULL,             -- Where to send SMS
    last_comment_hash TEXT,                  -- To detect new comments
    last_checked INTEGER                     -- For efficient polling
);

-- Index for polling efficiency
CREATE INDEX IF NOT EXISTS idx_last_checked ON monitored_contacts(last_checked);