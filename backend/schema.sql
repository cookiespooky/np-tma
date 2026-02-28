-- Run against your dedicated serverless YDB database for this project.
CREATE TABLE `tma_users` (
  user_id Uint64 NOT NULL,
  username Utf8,
  first_name Utf8,
  last_name Utf8,
  first_seen_at Timestamp NOT NULL,
  last_seen_at Timestamp NOT NULL,
  last_lead_at Timestamp,
  PRIMARY KEY (user_id)
);

