-- Add role column to users table for admin authentication
-- Migration: 013_add_user_roles.sql

-- Add role enum type
DO $$ BEGIN
    CREATE TYPE user_role AS ENUM ('user', 'admin', 'support');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Add role column with default value
ALTER TABLE users
ADD COLUMN IF NOT EXISTS role user_role DEFAULT 'user' NOT NULL;

-- Create index for efficient role queries
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- Comment for clarity
COMMENT ON COLUMN users.role IS 'User role for access control: user, admin, or support';