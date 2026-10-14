// The UI's icons: one line style (24 x 24 box, 1.6 stroke, round ends, currentColor), so menu, HUD and
// touch controls look like one set. icon(name) returns the inline SVG.

const P = {
  // panel sections
  car: '<path d="M2.5 15.5V11l2.4-4h9.6l3.3 4h2.7a1 1 0 0 1 1 1v3.5"/><path d="M2.5 11h15.3"/><path d="M4.6 15.5h.4M9.4 15.5h5.2M19.4 15.5h2.1"/><circle cx="7" cy="15.8" r="2.2"/><circle cx="17" cy="15.8" r="2.2"/>',
  wheel: '<circle cx="12" cy="12" r="8.6"/><circle cx="12" cy="12" r="2.1"/><path d="M3.7 10.3 9.9 11.6M14.1 11.6l6.2-1.3M12 14.1v6.4"/>',
  wrench: '<path d="M14.8 3.6a4.6 4.6 0 0 0-5.4 6.1l-5.6 5.6a2 2 0 0 0 2.9 2.9l5.6-5.6a4.6 4.6 0 0 0 6.1-5.4l-2.9 2.9-2.6-.5-.5-2.6z"/>',
  pin: '<path d="M12 21.2s-6.6-5.7-6.6-11.2a6.6 6.6 0 0 1 13.2 0c0 5.5-6.6 11.2-6.6 11.2z"/><circle cx="12" cy="10" r="2.4"/>',
  camera: '<path d="M3.2 8.2h3.4l1.6-2.6h7.6l1.6 2.6h3.4v10.9H3.2z"/><circle cx="12" cy="13.3" r="3.4"/>',
  world: '<path d="M8 3.2v1.4M3 8.2h1.4M4.5 4.7l1 1M11.5 4.7l-1 1"/><path d="M5.3 11.2A3.6 3.6 0 1 1 11.6 7.5"/><path d="M8.4 19.4h9.4a3.4 3.4 0 0 0 .3-6.8 4.9 4.9 0 0 0-9.4 1.1 2.9 2.9 0 0 0-.3 5.7z"/>',
  image: '<rect x="3" y="4.8" width="18" height="14.4" rx="2"/><path d="m3.6 16.6 5-5 4 4 2.8-2.8 4.9 4.9"/><circle cx="15.6" cy="9.2" r="1.6"/>',
  gauge: '<path d="M4.4 17.6a8.8 8.8 0 1 1 15.2 0"/><path d="m12 13.4 3.8-4.2"/><circle cx="12" cy="13.6" r="1.3"/><path d="M6.2 13.2h1.2M12 6.6v1.2M17.8 13.2h-1.2"/>',
  sliders: '<path d="M4 6.5h9M17.4 6.5H20M4 12h2.6M11 12h9M4 17.5h11M19.4 17.5h.6"/><circle cx="15.2" cy="6.5" r="2.1"/><circle cx="8.8" cy="12" r="2.1"/><circle cx="17.2" cy="17.5" r="2.1"/>',
  people: '<circle cx="9" cy="8.2" r="3.2"/><path d="M3.2 19.4a5.8 5.8 0 0 1 11.6 0"/><path d="M15.6 5.2a3.2 3.2 0 0 1 0 6M17.4 13.9a5.8 5.8 0 0 1 3.4 5.5"/>',
  keyboard: '<rect x="2.6" y="6" width="18.8" height="12" rx="2"/><path d="M6.2 9.8h.01M9.4 9.8h.01M12.6 9.8h.01M15.8 9.8h.01M6.2 13.9h.01M17.8 13.9h.01M9.4 13.9h5.2M17.8 9.8h.01" stroke-width="2"/>',

  // panel chrome
  info: '<circle cx="12" cy="12" r="8.6"/><path d="M12 10.8v5.6"/><path d="M12 7.6v.01" stroke-width="2.1"/>',
  close: '<path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/>',
  pause: '<path d="M9 6.5v11M15 6.5v11" stroke-width="2"/>',
  play: '<path d="M8.5 5.8v12.4l10-6.2z" fill="currentColor"/>',
  recover: '<path d="M4.8 12a7.2 7.2 0 1 0 2.2-5.2"/><path d="M5.6 3.4v4.2h4.2"/>',
  menu: '<path d="M4.5 7h15M4.5 12h15M4.5 17h15"/>',
  fullscreen: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
  fullscreenExit: '<path d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5"/>',
  sound: '<path d="M3.5 9.2h3.4L11.6 5v14l-4.7-4.2H3.5z"/><path d="M15.2 9a4.2 4.2 0 0 1 0 6M17.8 6.4a7.8 7.8 0 0 1 0 11.2"/>',
  muted: '<path d="M3.5 9.2h3.4L11.6 5v14l-4.7-4.2H3.5z"/><path d="m15.4 9.4 5.2 5.2M20.6 9.4l-5.2 5.2"/>',
  minus: '<path d="M6 12h12"/>',
  plus: '<path d="M6 12h12M12 6v12"/>',
  reset: '<path d="M4.8 12a7.2 7.2 0 1 0 2.2-5.2"/><path d="M5.6 3.4v4.2h4.2"/>',
  link: '<path d="M10 14a4.2 4.2 0 0 0 6 0l3-3a4.2 4.2 0 0 0-6-6l-1 1"/><path d="M14 10a4.2 4.2 0 0 0-6 0l-3 3a4.2 4.2 0 0 0 6 6l1-1"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  here: '<circle cx="12" cy="12" r="3.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="7.4"/>',

  // world
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.8v2M12 19.2v2M2.8 12h2M19.2 12h2M5.5 5.5l1.4 1.4M17.1 17.1l1.4 1.4M5.5 18.5l1.4-1.4M17.1 6.9l1.4-1.4"/>',
  dusk: '<path d="M3 17.5h18M6.5 20.5h11"/><path d="M7.2 17.5a4.8 4.8 0 0 1 9.6 0"/><path d="M12 5v2.6M4.6 9.6l1.8 1.4M19.4 9.6l-1.8 1.4"/>',
  moon: '<path d="M19.4 14.6A8 8 0 1 1 9.4 4.6a6.4 6.4 0 0 0 10 10z"/>',
  changing: '<path d="M8 3.2v1.4M3 8.2h1.4M4.5 4.7l1 1M11.5 4.7l-1 1"/><path d="M5.3 11.2A3.6 3.6 0 1 1 11.6 7.5"/><path d="M8.4 16.6h9.4a3.4 3.4 0 0 0 .3-6.8 4.9 4.9 0 0 0-9.4 1.1 2.9 2.9 0 0 0-.3 5.7z"/><path d="M10.6 19.4l-.6 1.6M14.6 19.4l-.6 1.6"/>',
  rain: '<path d="M7.2 14.6h10.6a3.6 3.6 0 0 0 .3-7.2 5.2 5.2 0 0 0-10 1.2 3 3 0 0 0-.9 6z"/><path d="m8.6 17.4-1 2.6M12.6 17.4l-1 2.6M16.6 17.4l-1 2.6"/>',

  // car systems (ISO 2575 style where one exists)
  engine: '<path d="M7 7.8h6v2h3.2l1.8 2.2h2v-2.2h1.2v6.4H20v-2h-2l-2 2.6h-6.6L7.6 15H5.4v2.2H4.2v-6.6h1.2v2.2h1.6z"/><path d="M8.6 7.8V6h2.8"/>',
  handbrake: '<circle cx="12" cy="12" r="6.2"/><path d="M5 6.4a9 9 0 0 0 0 11.2M19 6.4a9 9 0 0 1 0 11.2"/><path d="M10.4 15.2V8.8h2.2a1.8 1.8 0 0 1 0 3.6h-2.2"/>',
  traction: '<path d="M6.8 10 8.3 5.6h7.4l1.5 4.4"/><rect x="5.4" y="10" width="13.2" height="3.8" rx=".9"/><path d="M7.2 13.8v1.3M16.8 13.8v1.3"/><path d="M8.2 21.8c-1.7-1.2 1.7-2.3 0-3.5M15.8 21.8c-1.7-1.2 1.7-2.3 0-3.5"/>',
  abs: '<circle cx="12" cy="12" r="6.4"/><path d="M4.6 6.6a9.2 9.2 0 0 0 0 10.8M19.4 6.6a9.2 9.2 0 0 1 0 10.8"/><text x="12" y="13.9" text-anchor="middle" font-size="5.6" font-weight="800" fill="currentColor" stroke="none" font-family="system-ui, sans-serif" letter-spacing=".1">ABS</text>',
  steerAssist: '<circle cx="12" cy="12" r="7.6"/><circle cx="12" cy="12" r="1.8"/><path d="M4.6 10.6 10.2 11.6M13.8 11.6l5.6-1M12 13.8v5.8"/>',
  lowBeam: '<path d="M11.4 6.2c-3.4 0-5 2.6-5 5.8s1.6 5.8 5 5.8z"/><path d="M14.4 9.4l6 1.6M14.4 12.6l6 1.6M14.4 15.8l6 1.6"/>',
  highBeam: '<path d="M11.4 6.2c-3.4 0-5 2.6-5 5.8s1.6 5.8 5 5.8z"/><path d="M14.4 8h6M14.4 10.7h6M14.4 13.3h6M14.4 16h6"/>',
  beamOff: '<path d="M11.4 6.2c-3.4 0-5 2.6-5 5.8s1.6 5.8 5 5.8z"/>',
  aux: '<circle cx="8.4" cy="12" r="4.6"/><circle cx="8.4" cy="12" r="1.6"/><path d="M15.2 8.4l5-1.6M15.4 12h5.2M15.2 15.6l5 1.6"/>',
  hazard: '<path d="M12 4.2 21 19.4H3z" stroke-linejoin="round"/><path d="M12 9.4l3.8 6.6H8.2z" stroke-linejoin="round"/>',
  tyre: '<path d="M6 4.8c-2 3.4-2 10.4 0 14.4h12c2-4 2-11 0-14.4z"/><path d="M8.2 8.4c-.6 2.2-.6 5 0 7.2M15.8 8.4c.6 2.2.6 5 0 7.2"/>',
  arcade: '<path d="M12 9.8v6"/><circle cx="12" cy="6.6" r="3"/><path d="M5.4 19.6h13.2l-1.3-3.8H6.7z"/>',
  clutch: '<path d="M7.4 3.8l4.4 11.4"/><path d="m9.4 15.6 7.4-1.8.7 2.7-7.4 1.8z"/><path d="M4.8 21h14.4"/>',
  autoShift: '<path d="M7 5v14M12 5v14M17 5v7M7 12h10"/>',
  people2: '<circle cx="9" cy="8.2" r="3.2"/><path d="M3.2 19.4a5.8 5.8 0 0 1 11.6 0"/><path d="M15.6 5.2a3.2 3.2 0 0 1 0 6M17.4 13.9a5.8 5.8 0 0 1 3.4 5.5"/>',
  ghost: '<path d="M6 20V11a6 6 0 0 1 12 0v9l-2-1.6-2 1.6-2-1.6-2 1.6-2-1.6z"/><path d="M10 10.4v.01M14 10.4v.01" stroke-width="2.1"/>',
};

export const ICONS = P;

export function icon(name, cls = '') {
  const p = P[name];
  if (!p) return '';
  return `<svg class="ic${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}
