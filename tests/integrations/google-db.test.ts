/**
 * Every Google test that needs the database, run against ONE in-process Postgres.
 * (A PGlite instance per file is the expensive part of the suite; see setupTestDb.)
 */
import "./suites/common-db";
import "./suites/google-outbound";
import "./suites/google-inbound";
import "./suites/google-channel";
import "./suites/google-routes";
import "./suites/google-jobs";
import "./suites/google-per-stylist";
