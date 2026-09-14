-- Additive defaults for Main message queueing. Task messages are JSON entities whose optional
-- delivery fields are normalized by core when read.
ALTER TABLE lead_messages ADD COLUMN when_to_send TEXT NOT NULL DEFAULT 'now'
  CHECK(when_to_send IN ('now','after_turn'));
