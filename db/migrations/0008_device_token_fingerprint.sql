ALTER TABLE device_tokens ADD COLUMN token_hash bytea;
ALTER TABLE device_tokens ADD CONSTRAINT device_tokens_token_hash_size CHECK (octet_length(token_hash) = 32);
CREATE UNIQUE INDEX device_tokens_platform_hash_idx ON device_tokens (platform, token_hash);
