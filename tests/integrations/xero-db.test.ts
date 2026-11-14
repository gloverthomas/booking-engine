/** Every Xero test that needs the database, run against ONE in-process Postgres. */
import "./suites/xero-consumer";
import "./suites/xero-runtime";
import "./suites/xero-routes";
import "./suites/xero-jobs";
