// Authored room seconds. Pure data shared by the card rules and trusted host.
// Evidence age and legacy permissions remain separate from movement duration.
export const UNPERSON_ROOM_TIMING = Object.freeze({
  absence: 30,
  attendanceGrace: 15,
  overdueGrace: 30,
  attendanceCooldown: 30,
  overdueNotices: 2,
  concession: 45,
  legacyConcession: 12,
  concessionEvidence: 45,
  inspectionEarliest: 35,
  inspectionLatest: 60,
});
