-- Akrio Verify - FreeAgent integration schema migration.
--
-- Run this ONCE, directly in DBeaver, connected to kpimanagementmysqldb, using the same
-- write-capable user used for scripts/mysql-schema.sql. Additive only - does not touch any
-- existing Xero data or tables.
--
-- What this does:
--   1. Relaxes akrio_organisations.xero_tenant_id from NOT NULL to nullable - a client can now
--      be connected via FreeAgent instead of Xero (a client always has exactly one of the two).
--   2. Adds a nullable, unique freeagent_company_id column alongside it.
--   3. Adds akrio_freeagent_tokens, mirroring akrio_xero_tokens but simpler - FreeAgent tokens
--      are one-company-per-token, with no "one refresh token shared across many tenants"
--      complexity to replicate.

SET NAMES utf8mb4;

ALTER TABLE akrio_organisations
  MODIFY xero_tenant_id VARCHAR(255) NULL;

ALTER TABLE akrio_organisations
  ADD COLUMN freeagent_company_id VARCHAR(255) NULL AFTER xero_tenant_id,
  ADD UNIQUE KEY uq_organisations_freeagent (freeagent_company_id);

CREATE TABLE IF NOT EXISTS akrio_freeagent_tokens (
  id INT AUTO_INCREMENT PRIMARY KEY,
  freeagent_company_id VARCHAR(255) NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_freeagent_tokens_company (freeagent_company_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
