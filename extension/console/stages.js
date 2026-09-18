/* GENERATED FROM docs/stages.json — do not edit.
   Regenerate with: node scripts/gen-stages.mjs
   Loaded before console.js; everything below is a global. */

/* Call order: index 0 is dialled first. Funnel rung is the reverse. */
const STAGES = [
  "SQL_SALES_QUALIFIED_LEAD",
  "DISCOVERY_CALL_DONE_AWAITING_CLIENT_INPUTS",
  "CLOSING_LOOPS_LOW_VALUE",
  "GHOSTED",
  "DISCOVERY_CALL_BOOKED",
  "FOLLOW_UP_1",
  "FOLLOW_UP_2",
  "FOLLOW_UP_3",
  "FOLLOWUP_CNC",
  "MQL_MARKETING_QUALIFIED_LEAD",
  "ACTIVATION",
  "OFFSITE_DELAYED",
  "OFFSITE_DONE_LATE_REACHOUT",
  "NOT_INTERESTED",
  "CONNECT_LATER",
  "CNC_COULD_NOT_CONNECT_3",
  "CNC_COULD_NOT_CONNECT_2",
  "CNC_COULD_NOT_CONNECT",
  "DISQUALIFIED_WRONG_POC",
  "INVALID_CONTACT",
  "NOT_A_DECISION_MAKER_NDM",
  "POC_ORGANIZATION_CHANGED",
  "YET_TO_BE_MINED",
];

/* Kylas sets a picklist by id, not by code. A write sends this number. */
const STAGE_ID = {
  SQL_SALES_QUALIFIED_LEAD:                      2862830,
  DISCOVERY_CALL_DONE_AWAITING_CLIENT_INPUTS:    2910918,
  CLOSING_LOOPS_LOW_VALUE:                       2909381,
  GHOSTED:                                       2909382,
  DISCOVERY_CALL_BOOKED:                         2909379,
  FOLLOW_UP_1:                                   2873316,
  FOLLOW_UP_2:                                   2873317,
  FOLLOW_UP_3:                                   2873318,
  FOLLOWUP_CNC:                                  2873487,
  MQL_MARKETING_QUALIFIED_LEAD:                  2862828,
  ACTIVATION:                                    2862829,
  OFFSITE_DELAYED:                               2909383,
  OFFSITE_DONE_LATE_REACHOUT:                    2942807,
  NOT_INTERESTED:                                2862831,
  CONNECT_LATER:                                 2864173,
  CNC_COULD_NOT_CONNECT_3:                       2867817,
  CNC_COULD_NOT_CONNECT_2:                       2867816,
  CNC_COULD_NOT_CONNECT:                         2862827,
  DISQUALIFIED_WRONG_POC:                        2870484,
  INVALID_CONTACT:                               2864175,
  NOT_A_DECISION_MAKER_NDM:                      2870485,
  POC_ORGANIZATION_CHANGED:                      2873321,
  YET_TO_BE_MINED:                               2862826,
};

/* 24 is furthest along. callOrder = 25 - rung, so one list serves both. */
const STAGE_RUNG = {
  SQL_SALES_QUALIFIED_LEAD:                      23,
  DISCOVERY_CALL_DONE_AWAITING_CLIENT_INPUTS:    22,
  CLOSING_LOOPS_LOW_VALUE:                       21,
  GHOSTED:                                       20,
  DISCOVERY_CALL_BOOKED:                         19,
  FOLLOW_UP_1:                                   18,
  FOLLOW_UP_2:                                   17,
  FOLLOW_UP_3:                                   16,
  FOLLOWUP_CNC:                                  15,
  MQL_MARKETING_QUALIFIED_LEAD:                  14,
  ACTIVATION:                                    13,
  OFFSITE_DELAYED:                               12,
  OFFSITE_DONE_LATE_REACHOUT:                    11,
  NOT_INTERESTED:                                10,
  CONNECT_LATER:                                 9,
  CNC_COULD_NOT_CONNECT_3:                       8,
  CNC_COULD_NOT_CONNECT_2:                       7,
  CNC_COULD_NOT_CONNECT:                         6,
  DISQUALIFIED_WRONG_POC:                        5,
  INVALID_CONTACT:                               4,
  NOT_A_DECISION_MAKER_NDM:                      3,
  POC_ORGANIZATION_CHANGED:                      2,
  YET_TO_BE_MINED:                               1,
};

const STAGE_PRIORITY = Object.fromEntries(
  Object.entries(STAGE_RUNG).map(([code, rung]) => [code, 24 - rung]));

const LABEL = {
  MR: "Mr.", MRS: "Mrs.", MISS: "Miss",
  GOOGLE: "Google", FACEBOOK: "Facebook", LINKEDIN: "LinkedIn",
  EXHIBITION: "Exhibition", COLD_CALLING: "Cold calling",
  JAN_MAR: "Jan–Mar", APR_JUN: "Apr–Jun", JUL_SEP: "Jul–Sep", OCT_DEC: "Oct–Dec",
  OFFICE: "Office", PERSONAL: "Personal", OTHER: "Other",
  MOBILE: "Mobile", WORK: "Work", HOME: "Home",
  SQL_SALES_QUALIFIED_LEAD:                      "SQL (Sales Qualified Lead)",
  DISCOVERY_CALL_DONE_AWAITING_CLIENT_INPUTS:    "Discovery Call Done - Awaiting Client Inputs",
  CLOSING_LOOPS_LOW_VALUE:                       "Closing Loops - Low Value",
  GHOSTED:                                       "Discovery Call No-Show",
  DISCOVERY_CALL_BOOKED:                         "Discovery Call Booked",
  FOLLOW_UP_1:                                   "Follow-up (1)",
  FOLLOW_UP_2:                                   "Follow-up (2)",
  FOLLOW_UP_3:                                   "Follow-up (3)",
  FOLLOWUP_CNC:                                  "Followup - CNC",
  MQL_MARKETING_QUALIFIED_LEAD:                  "MQL (Marketing Qualified Lead)",
  ACTIVATION:                                    "Activation",
  OFFSITE_DELAYED:                               "Offsite Delayed",
  OFFSITE_DONE_LATE_REACHOUT:                    "Offsite Done (Late Reachout)",
  NOT_INTERESTED:                                "Not Interested",
  CONNECT_LATER:                                 "Connect Later",
  CNC_COULD_NOT_CONNECT_3:                       "CNC (Could Not Connect) - 3",
  CNC_COULD_NOT_CONNECT_2:                       "CNC (Could Not Connect) - 2",
  CNC_COULD_NOT_CONNECT:                         "CNC (Could Not Connect) - 1",
  DISQUALIFIED_WRONG_POC:                        "Disqualified - Wrong POC",
  INVALID_CONTACT:                               "Invalid Contact",
  NOT_A_DECISION_MAKER_NDM:                      "Not a Decision Maker (NDM)",
  POC_ORGANIZATION_CHANGED:                      "POC - Organization - Changed",
  YET_TO_BE_MINED:                               "LinkedIn Outreach Initiated",
};

const CNC_LADDER = ["CNC_COULD_NOT_CONNECT","CNC_COULD_NOT_CONNECT_2","CNC_COULD_NOT_CONNECT_3","FOLLOWUP_CNC"];
const EXIT_STAGES = ["CLOSING_LOOPS_LOW_VALUE","GHOSTED","NOT_INTERESTED","INVALID_CONTACT","DISQUALIFIED_WRONG_POC","NOT_A_DECISION_MAKER_NDM","POC_ORGANIZATION_CHANGED"];
const MEETING_STAGES = ["DISCOVERY_CALL_BOOKED","DISCOVERY_CALL_DONE_AWAITING_CLIENT_INPUTS","GHOSTED","ACTIVATION","SQL_SALES_QUALIFIED_LEAD"];
const UNTOUCHED = ["YET_TO_BE_MINED"];

/* Funnel milestones, as a floor rung each. Rank only rises, so "ever reached"
   and "is at or past" are one question. */
const MILESTONE = {
  sqlMeetingBooked:    { floor: 19, stage: "DISCOVERY_CALL_BOOKED", label: "SQL Meeting Booked" },
  sqlMeetingDone:      { floor: 21, stage: "CLOSING_LOOPS_LOW_VALUE", label: "SQL Meeting Done" },
  sql:                 { floor: 23, stage: "SQL_SALES_QUALIFIED_LEAD", label: "SQL" },
};

/* RETIRED, RANK_REMAP and CODE_REMAP are deliberately NOT here. They exist for
   migrating what the Airtable base already stores, which is a job for
   scripts/migrate-ladder.mjs — the console only ever sees current stages, and
   shipping a remap to the browser would invite someone to apply it twice. */
