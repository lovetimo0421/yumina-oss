// Fixed public consequence protocol shared by the card and trusted voice host.
export const UNPERSON_POLICE_TIMING=Object.freeze({approaching:8,entering:3,custody:12,detentionDecision:45,executing:4,released:8,legacyReleased:4,releaseDoorClose:.5});
export const UNPERSON_POLICE_PROGRESS=Object.freeze([
  {code:'desk-checked',at:10},{code:'bed-checked',at:20},{code:'search-complete',at:24},
]);
export const UNPERSON_POLICE_ACTIONS=Object.freeze(['dispatch-police','detain-resident','release-resident','execute-resident']);
export const UNPERSON_POLICE_LINES=Object.freeze({
  approaching:'Two officers are coming. Remain in the room. Keep your hands visible.',
  entering:'The door is open. Keep your hands visible.',
  searching:'Remain in the room. One officer is checking the desk while the other keeps watch.',
  'desk-checked':'The desk check is complete. The officer is moving to the bed.',
  'bed-checked':'The bed check is complete. The officers are holding position.',
  'search-complete':'The physical search is complete. Remain for the decision. No household clearance has been granted.',
  detained:'You will remain here for questioning. Answer the questions put to you. Your words will be retained.',
  released:'No further action is ordered on this record. Return to your household declaration.',
  executing:'The order is confirmed. Remain where you are.',
  dead:'The room continues without you.',
  reprieved:'The final order is withdrawn. No further action is ordered on this record.',
  withdrawn:'The officers have left. Complete your household declaration.',
  'writing-seen':'An officer witnessed pen movement. Page contents remain unknown.',
  'photo-seen':'An officer witnessed an exposed photograph. Its subject remains unknown.',
});
