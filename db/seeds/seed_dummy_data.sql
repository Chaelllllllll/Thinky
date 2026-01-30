-- Seed data for Thinky (dummy users, online_users, general and private messages)
-- Instructions: paste this into Supabase SQL editor or run with psql against your database.
-- Run in Supabase SQL editor: open SQL editor -> paste -> Run
-- Or locally with psql:
-- psql "postgresql://USER:PASSWORD@HOST:PORT/DATABASE" -f db/seeds/seed_dummy_data.sql

BEGIN;

-- Insert dummy users (will not duplicate if email already exists)
INSERT INTO users (email, username, password_hash, role, is_verified)
VALUES
  ('alice@example.com', 'alice', '$2b$10$xxdummyhashforseedxxxxxxdummyhashxxxxxx', 'student', true),
  ('bob@example.com', 'bob', '$2b$10$xxdummyhashforseedxxxxxxdummyhashxxxxxx', 'student', true),
  ('carol@example.com', 'carol', '$2b$10$xxdummyhashforseedxxxxxxdummyhashxxxxxx', 'student', true),
  ('dave@example.com', 'dave', '$2b$10$xxdummyhashforseedxxxxxxdummyhashxxxxxx', 'student', true)
ON CONFLICT (email) DO NOTHING;

-- Insert sample subjects for each user (optional, used if reviewers need subjects)
INSERT INTO subjects (user_id, name, description)
SELECT id, 'Sample Subject for ' || username, 'Auto-created sample subject'
FROM users
WHERE email IN ('alice@example.com','bob@example.com','carol@example.com','dave@example.com')
ON CONFLICT DO NOTHING;

-- Insert online_users for Alice and Bob (simulate them being online)
INSERT INTO online_users (user_id, username, last_seen)
VALUES
  ((SELECT id FROM users WHERE email = 'alice@example.com'), 'alice', NOW()),
  ((SELECT id FROM users WHERE email = 'bob@example.com'), 'bob', NOW())
ON CONFLICT (user_id) DO UPDATE SET last_seen = EXCLUDED.last_seen, username = EXCLUDED.username;

-- Insert general chat messages (recipient_id NULL)
INSERT INTO messages (user_id, recipient_id, username, message, chat_type, created_at)
VALUES
  ((SELECT id FROM users WHERE email = 'alice@example.com'), NULL, 'alice', 'Hello everyone! This is a general message from Alice.', 'general', NOW() - INTERVAL '10 minutes'),
  ((SELECT id FROM users WHERE email = 'bob@example.com'), NULL, 'bob', 'Hey team — Bob here in general chat.', 'general', NOW() - INTERVAL '9 minutes'),
  ((SELECT id FROM users WHERE email = 'carol@example.com'), NULL, 'carol', 'Carol checking in — general chat message.', 'general', NOW() - INTERVAL '8 minutes');

-- Insert online chat messages (chat_type = 'online')
INSERT INTO messages (user_id, recipient_id, username, message, chat_type, created_at)
VALUES
  ((SELECT id FROM users WHERE email = 'bob@example.com'), NULL, 'bob', 'Bob is online and says hi!', 'online', NOW() - INTERVAL '7 minutes');

-- Insert private messages (recipient_id set)
INSERT INTO messages (user_id, recipient_id, username, message, chat_type, created_at)
VALUES
  ((SELECT id FROM users WHERE email = 'alice@example.com'), (SELECT id FROM users WHERE email = 'bob@example.com'), 'alice', 'Hey Bob — this is a private message from Alice to you.', 'private', NOW() - INTERVAL '6 minutes'),
  ((SELECT id FROM users WHERE email = 'bob@example.com'), (SELECT id FROM users WHERE email = 'alice@example.com'), 'bob', 'Thanks Alice — got your private message!', 'private', NOW() - INTERVAL '5 minutes'),
  ((SELECT id FROM users WHERE email = 'carol@example.com'), (SELECT id FROM users WHERE email = 'dave@example.com'), 'carol', 'Private hello Dave — testing 1:1 messages.', 'private', NOW() - INTERVAL '4 minutes');

COMMIT;

-- CLEANUP for reviewers (optional):
-- DELETE FROM reviewers WHERE title LIKE 'Sample Notes by %' AND user_id IN (SELECT id FROM users WHERE email IN ('alice@example.com','bob@example.com','carol@example.com','dave@example.com'));

-- CLEANUP (run these to remove seeded data created by this file)
-- Note: these statements remove messages and users by the known emails above.
-- Run carefully in production.
--
-- DELETE FROM messages WHERE user_id IN (SELECT id FROM users WHERE email IN ('alice@example.com','bob@example.com','carol@example.com','dave@example.com'))
--    OR recipient_id IN (SELECT id FROM users WHERE email IN ('alice@example.com','bob@example.com','carol@example.com','dave@example.com'));
-- DELETE FROM online_users WHERE user_id IN (SELECT id FROM users WHERE email IN ('alice@example.com','bob@example.com'));
-- DELETE FROM subjects WHERE user_id IN (SELECT id FROM users WHERE email IN ('alice@example.com','bob@example.com','carol@example.com','dave@example.com'));
-- DELETE FROM users WHERE email IN ('alice@example.com','bob@example.com','carol@example.com','dave@example.com');
