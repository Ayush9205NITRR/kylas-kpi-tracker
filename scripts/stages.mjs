/* GENERATED FROM docs/stages.json — do not edit.
   Regenerate with: node scripts/gen-stages.mjs
   Imported by schema.mjs and the writers. */

export const STAGES = [
  "SQL_SALES_QUALIFIED_LEAD",
  "ACTIVE_REQUIREMENT_CALL_DONE_–_AWAITING_CLIENT_INPUTS",
  "ACTIVE_REQUIREMENT_CALL_NO_SHOW",
  "ACTIVE_REQUIREMENT_CALL_BOOKED",
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

export const STAGE_ID = {
  SQL_SALES_QUALIFIED_LEAD:                      2862830,
  "ACTIVE_REQUIREMENT_CALL_DONE_–_AWAITING_CLIENT_INPUTS": 2991647,
  ACTIVE_REQUIREMENT_CALL_NO_SHOW:               2991646,
  ACTIVE_REQUIREMENT_CALL_BOOKED:                2991645,
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

export const STAGE_RUNG = {
  SQL_SALES_QUALIFIED_LEAD:                      26,
  "ACTIVE_REQUIREMENT_CALL_DONE_–_AWAITING_CLIENT_INPUTS": 25,
  ACTIVE_REQUIREMENT_CALL_NO_SHOW:               24,
  ACTIVE_REQUIREMENT_CALL_BOOKED:                23,
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

/* What a person reading the record calls it. */
export const STAGE_LABEL = {
  SQL_SALES_QUALIFIED_LEAD:                      "SQL (Sales Qualified Lead)",
  "ACTIVE_REQUIREMENT_CALL_DONE_–_AWAITING_CLIENT_INPUTS": "Active Requirement Call Done – Awaiting Client Inputs",
  ACTIVE_REQUIREMENT_CALL_NO_SHOW:               "Active Requirement Call No-Show",
  ACTIVE_REQUIREMENT_CALL_BOOKED:                "Active Requirement Call Booked",
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

/* [rung, label] lowest first, for the Airtable ladder formula. */
/* RUNG → STAGE, the ladder read the other way. STAGE_RUNG answers "how far is
   this stage"; this answers "what stage is this far", which is what anything
   holding a rank rather than a code needs — KPI Rank is a number and the name
   beside it has to be the name of THAT rung. Built from STAGE_RUNG so the two
   can never disagree. */
export const STAGE_AT_RUNG = Object.fromEntries(
  Object.entries(STAGE_RUNG).map(([code, rung]) => [rung, code]));

export const LADDER = [
  [1, "01 · LinkedIn Outreach Initiated"],
  [2, "02 · POC - Organization - Changed"],
  [3, "03 · Not a Decision Maker (NDM)"],
  [4, "04 · Invalid Contact"],
  [5, "05 · Disqualified - Wrong POC"],
  [6, "06 · CNC (Could Not Connect) - 1"],
  [7, "07 · CNC (Could Not Connect) - 2"],
  [8, "08 · CNC (Could Not Connect) - 3"],
  [9, "09 · Connect Later"],
  [10, "10 · Not Interested"],
  [11, "11 · Offsite Done (Late Reachout)"],
  [12, "12 · Offsite Delayed"],
  [13, "13 · Activation"],
  [14, "14 · MQL (Marketing Qualified Lead)"],
  [15, "15 · Followup - CNC"],
  [16, "16 · Follow-up (3)"],
  [17, "17 · Follow-up (2)"],
  [18, "18 · Follow-up (1)"],
  [19, "19 · Discovery Call Booked"],
  [20, "20 · Discovery Call No-Show"],
  [21, "21 · Closing Loops - Low Value"],
  [22, "22 · Discovery Call Done - Awaiting Client Inputs"],
  [23, "23 · Active Requirement Call Booked"],
  [24, "24 · Active Requirement Call No-Show"],
  [25, "25 · Active Requirement Call Done – Awaiting Client Inputs"],
  [26, "26 · SQL (Sales Qualified Lead)"],
];

export const CNC_LADDER = ["CNC_COULD_NOT_CONNECT","CNC_COULD_NOT_CONNECT_2","CNC_COULD_NOT_CONNECT_3","FOLLOWUP_CNC"];
export const EXIT_STAGES = ["CLOSING_LOOPS_LOW_VALUE","GHOSTED","NOT_INTERESTED","INVALID_CONTACT","DISQUALIFIED_WRONG_POC","NOT_A_DECISION_MAKER_NDM","POC_ORGANIZATION_CHANGED"];
export const MEETING_STAGES = ["DISCOVERY_CALL_BOOKED","DISCOVERY_CALL_DONE_AWAITING_CLIENT_INPUTS","GHOSTED","ACTIVE_REQUIREMENT_CALL_BOOKED","ACTIVE_REQUIREMENT_CALL_NO_SHOW","ACTIVE_REQUIREMENT_CALL_DONE_–_AWAITING_CLIENT_INPUTS","ACTIVATION","SQL_SALES_QUALIFIED_LEAD"];
export const UNTOUCHED = ["YET_TO_BE_MINED"];

export const STAGE_FAMILIES = [{"key":"new","label":"Not started","hint":"never called","stages":["YET_TO_BE_MINED"]},{"key":"cnc","label":"CNC","hint":"dialled, nobody picked up — or asked to be called later","stages":["CNC_COULD_NOT_CONNECT","CNC_COULD_NOT_CONNECT_2","CNC_COULD_NOT_CONNECT_3","FOLLOWUP_CNC","CONNECT_LATER"]},{"key":"active","label":"Activation and above","hint":"a real conversation is running","stages":["ACTIVATION","MQL_MARKETING_QUALIFIED_LEAD","FOLLOW_UP_1","FOLLOW_UP_2","FOLLOW_UP_3","OFFSITE_DELAYED","OFFSITE_DONE_LATE_REACHOUT","SQL_SALES_QUALIFIED_LEAD"]},{"key":"meeting","label":"Meeting in play","hint":"a meeting is booked, held or to be re-booked","stages":["DISCOVERY_CALL_BOOKED","GHOSTED","DISCOVERY_CALL_DONE_AWAITING_CLIENT_INPUTS","ACTIVE_REQUIREMENT_CALL_BOOKED","ACTIVE_REQUIREMENT_CALL_NO_SHOW","ACTIVE_REQUIREMENT_CALL_DONE_–_AWAITING_CLIENT_INPUTS"]},{"key":"newpoc","label":"Needs a new POC","hint":"the account is open, the person is wrong","stages":["DISQUALIFIED_WRONG_POC","NOT_A_DECISION_MAKER_NDM","POC_ORGANIZATION_CHANGED"]},{"key":"closed","label":"Closed","hint":"no call to make","stages":["NOT_INTERESTED","INVALID_CONTACT","CLOSING_LOOPS_LOW_VALUE"]}];
export const FAMILY_OF = {"YET_TO_BE_MINED":"new","CNC_COULD_NOT_CONNECT":"cnc","CNC_COULD_NOT_CONNECT_2":"cnc","CNC_COULD_NOT_CONNECT_3":"cnc","FOLLOWUP_CNC":"cnc","CONNECT_LATER":"cnc","ACTIVATION":"active","MQL_MARKETING_QUALIFIED_LEAD":"active","FOLLOW_UP_1":"active","FOLLOW_UP_2":"active","FOLLOW_UP_3":"active","OFFSITE_DELAYED":"active","OFFSITE_DONE_LATE_REACHOUT":"active","SQL_SALES_QUALIFIED_LEAD":"active","DISCOVERY_CALL_BOOKED":"meeting","GHOSTED":"meeting","DISCOVERY_CALL_DONE_AWAITING_CLIENT_INPUTS":"meeting","ACTIVE_REQUIREMENT_CALL_BOOKED":"meeting","ACTIVE_REQUIREMENT_CALL_NO_SHOW":"meeting","ACTIVE_REQUIREMENT_CALL_DONE_–_AWAITING_CLIENT_INPUTS":"meeting","DISQUALIFIED_WRONG_POC":"newpoc","NOT_A_DECISION_MAKER_NDM":"newpoc","POC_ORGANIZATION_CHANGED":"newpoc","NOT_INTERESTED":"closed","INVALID_CONTACT":"closed","CLOSING_LOOPS_LOW_VALUE":"closed"};

/* NOT CONNECTED: never touched, or touched and nobody answered. Phone Picked
   is the inverse of this, so the two runtimes MUST agree on it. console.js
   composed its own [...UNTOUCHED, ...CNC_LADDER] while airtable.mjs used a
   different test entirely, and the authoritative one — the writer — was the
   wrong one. Generated here so there is exactly one definition. */
export const NOT_CONNECTED = ["YET_TO_BE_MINED","CNC_COULD_NOT_CONNECT","CNC_COULD_NOT_CONNECT_2","CNC_COULD_NOT_CONNECT_3","FOLLOWUP_CNC"];

/* Funnel milestones, as a floor rung each. See docs/stages.json. */
export const MILESTONE = {
  sqlMeetingBooked:    { floor: 23, stage: "ACTIVE_REQUIREMENT_CALL_BOOKED", label: "SQL Meeting Booked" },
  sqlMeetingDone:      { floor: 25, stage: "ACTIVE_REQUIREMENT_CALL_DONE_–_AWAITING_CLIENT_INPUTS", label: "SQL Meeting Done" },
  sql:                 { floor: 26, stage: "SQL_SALES_QUALIFIED_LEAD", label: "SQL" },
  engaged:             { floor: 13, stage: "ACTIVATION", label: "Engaged" },
};

/* Stages removed from the pipeline, and where their records go. The live base
   still holds both their code and the rank numbers from the ladder they were
   part of. See docs/stages.json retiredNote. */
export const RETIRED = [{"code":"RESCHEDULE_PENDING","label":"Reschedule Pending","wasRung":21,"removedOn":"2026-09-17","mapTo":"GHOSTED","why":"Removed from the Kylas pipeline. A contact waiting to reschedule got as far as a discovery call that did not happen, which is what Discovery Call No-Show (GHOSTED) already records."}];

/* Stages ADDED after the live base was numbered. Declared for the same reason
   retired ones are, and the migration key is derived from both lists so a
   ladder change of either kind produces a key that has not run yet. */
export const ADDED = [{"code":"ACTIVE_REQUIREMENT_CALL_BOOKED","addedOn":"2026-09-19","why":"Kylas gained a second meeting track. Discovery Call is rungs 19-22; Active Requirement Call is the SQL meeting."},{"code":"ACTIVE_REQUIREMENT_CALL_NO_SHOW","addedOn":"2026-09-19","why":"Kylas gained a second meeting track. Discovery Call is rungs 19-22; Active Requirement Call is the SQL meeting."},{"code":"ACTIVE_REQUIREMENT_CALL_DONE_–_AWAITING_CLIENT_INPUTS","addedOn":"2026-09-19","why":"Kylas gained a second meeting track. Discovery Call is rungs 19-22; Active Requirement Call is the SQL meeting."}];

/* Stored KPI Rank remap, old numbering -> current. Derived by reconstructing
   the old ladder from RETIRED[].wasRung, so it cannot drift from the stage
   table. Anything absent here did not move. */
export const RANK_REMAP = {"21":20,"22":21,"23":22,"24":26};

/* Stage CODE remap for a value still sitting on a retired stage. */
export const CODE_REMAP = {"RESCHEDULE_PENDING":"GHOSTED"};
