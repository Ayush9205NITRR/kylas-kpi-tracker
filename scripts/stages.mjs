/* GENERATED FROM docs/stages.json — do not edit.
   Regenerate with: node scripts/gen-stages.mjs
   Imported by schema.mjs and the writers. */

export const STAGES = [
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

export const STAGE_ID = {
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

export const STAGE_RUNG = {
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

/* What a person reading the record calls it. */
export const STAGE_LABEL = {
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

/* [rung, label] lowest first, for the Airtable ladder formula. */
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
  [23, "23 · SQL (Sales Qualified Lead)"],
];

export const CNC_LADDER = ["CNC_COULD_NOT_CONNECT","CNC_COULD_NOT_CONNECT_2","CNC_COULD_NOT_CONNECT_3","FOLLOWUP_CNC"];
export const EXIT_STAGES = ["CLOSING_LOOPS_LOW_VALUE","GHOSTED","NOT_INTERESTED","INVALID_CONTACT","DISQUALIFIED_WRONG_POC","NOT_A_DECISION_MAKER_NDM","POC_ORGANIZATION_CHANGED"];
export const MEETING_STAGES = ["DISCOVERY_CALL_BOOKED","DISCOVERY_CALL_DONE_AWAITING_CLIENT_INPUTS","GHOSTED","ACTIVATION","SQL_SALES_QUALIFIED_LEAD"];
export const UNTOUCHED = ["YET_TO_BE_MINED"];

export const STAGE_FAMILIES = [{"key":"new","label":"Not touched yet","hint":"never called","stages":["YET_TO_BE_MINED"]},{"key":"trying","label":"Trying to connect","hint":"calls going out, no real conversation","stages":["CNC_COULD_NOT_CONNECT","CNC_COULD_NOT_CONNECT_2","CNC_COULD_NOT_CONNECT_3","FOLLOWUP_CNC"]},{"key":"talking","label":"In conversation","hint":"right person found, qualifying","stages":["MQL_MARKETING_QUALIFIED_LEAD","FOLLOW_UP_1","FOLLOW_UP_2","FOLLOW_UP_3","DISCOVERY_CALL_BOOKED","DISCOVERY_CALL_DONE_AWAITING_CLIENT_INPUTS"]},{"key":"qualified","label":"Qualified","hint":"SQL and beyond","stages":["SQL_SALES_QUALIFIED_LEAD","ACTIVATION"]},{"key":"parked","label":"Parked","hint":"alive, but not now","stages":["CONNECT_LATER","OFFSITE_DELAYED","OFFSITE_DONE_LATE_REACHOUT","GHOSTED"]},{"key":"closed","label":"Closed out","hint":"not a fit, or lost","stages":["CLOSING_LOOPS_LOW_VALUE","NOT_INTERESTED","INVALID_CONTACT","DISQUALIFIED_WRONG_POC","NOT_A_DECISION_MAKER_NDM","POC_ORGANIZATION_CHANGED"]}];
export const FAMILY_OF = {"YET_TO_BE_MINED":"new","CNC_COULD_NOT_CONNECT":"trying","CNC_COULD_NOT_CONNECT_2":"trying","CNC_COULD_NOT_CONNECT_3":"trying","FOLLOWUP_CNC":"trying","MQL_MARKETING_QUALIFIED_LEAD":"talking","FOLLOW_UP_1":"talking","FOLLOW_UP_2":"talking","FOLLOW_UP_3":"talking","DISCOVERY_CALL_BOOKED":"talking","DISCOVERY_CALL_DONE_AWAITING_CLIENT_INPUTS":"talking","SQL_SALES_QUALIFIED_LEAD":"qualified","ACTIVATION":"qualified","CONNECT_LATER":"parked","OFFSITE_DELAYED":"parked","OFFSITE_DONE_LATE_REACHOUT":"parked","GHOSTED":"parked","CLOSING_LOOPS_LOW_VALUE":"closed","NOT_INTERESTED":"closed","INVALID_CONTACT":"closed","DISQUALIFIED_WRONG_POC":"closed","NOT_A_DECISION_MAKER_NDM":"closed","POC_ORGANIZATION_CHANGED":"closed"};

/* NOT CONNECTED: never touched, or touched and nobody answered. Phone Picked
   is the inverse of this, so the two runtimes MUST agree on it. console.js
   composed its own [...UNTOUCHED, ...CNC_LADDER] while airtable.mjs used a
   different test entirely, and the authoritative one — the writer — was the
   wrong one. Generated here so there is exactly one definition. */
export const NOT_CONNECTED = ["YET_TO_BE_MINED","CNC_COULD_NOT_CONNECT","CNC_COULD_NOT_CONNECT_2","CNC_COULD_NOT_CONNECT_3","FOLLOWUP_CNC"];

/* Funnel milestones, as a floor rung each. See docs/stages.json. */
export const MILESTONE = {
  sqlMeetingBooked:    { floor: 19, stage: "DISCOVERY_CALL_BOOKED", label: "SQL Meeting Booked" },
  sqlMeetingDone:      { floor: 21, stage: "CLOSING_LOOPS_LOW_VALUE", label: "SQL Meeting Done" },
  sql:                 { floor: 23, stage: "SQL_SALES_QUALIFIED_LEAD", label: "SQL" },
};

/* Stages removed from the pipeline, and where their records go. The live base
   still holds both their code and the rank numbers from the ladder they were
   part of. See docs/stages.json retiredNote. */
export const RETIRED = [{"code":"RESCHEDULE_PENDING","label":"Reschedule Pending","wasRung":21,"removedOn":"2026-09-17","mapTo":"GHOSTED","why":"Removed from the Kylas pipeline. A contact waiting to reschedule got as far as a discovery call that did not happen, which is what Discovery Call No-Show (GHOSTED) already records."}];

/* Stored KPI Rank remap, old numbering -> current. Derived by reconstructing
   the old ladder from RETIRED[].wasRung, so it cannot drift from the stage
   table. Anything absent here did not move. */
export const RANK_REMAP = {"21":20,"22":21,"23":22,"24":23};

/* Stage CODE remap for a value still sitting on a retired stage. */
export const CODE_REMAP = {"RESCHEDULE_PENDING":"GHOSTED"};
