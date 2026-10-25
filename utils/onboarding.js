/*
 * Sign-up flow: 6 steps.
 *   1 Account (register + verify email)   4 Website (logo, photos, theme)
 *   2 Business details                    5 Plan
 *   3 Ground setup                        6 Preview and publish
 */
const STEPS = [
  { number: 1, key: 'account',  label: 'Account' },
  { number: 2, key: 'business', label: 'Business' },
  { number: 3, key: 'grounds',  label: 'Grounds' },
  { number: 4, key: 'website',  label: 'Website' },
  { number: 5, key: 'plan',     label: 'Plan' },
  { number: 6, key: 'publish',  label: 'Publish' }
];

/* Steps 2 to 6 live at /onboarding/<key> */
const STEP_PATHS = Object.fromEntries(STEPS.map((step) => [step.number, `/onboarding/${step.key}`]));

const DAYS = [
  ['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'],
  ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday']
];
const ALL_DAYS = DAYS.map(([key]) => key);

const JS_DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/* Is the turf open on this date ("YYYY-MM-DD")? A turf with no days saved is open every day. */
function isOperatingDay(tenant, dateString) {
  const days = tenant && Array.isArray(tenant.operatingDays) ? tenant.operatingDays : [];
  if (!days.length) return true;

  const [year, month, day] = String(dateString).split('-').map(Number);
  return days.includes(JS_DAY_KEYS[new Date(year, month - 1, day).getDay()]);
}

/*
 * Where an owner has to go next, or null when sign-up is finished.
 * Turfs created before this flow existed have no onboarding data and count as finished.
 */
function nextStepPath(user, tenant) {
  if (user.emailVerified === false) return '/onboarding/verify';
  if (!tenant) return STEP_PATHS[2];

  const onboarding = tenant.onboarding;
  if (!onboarding || onboarding.completed !== false) return null;

  return STEP_PATHS[onboarding.step] || STEP_PATHS[2];
}

module.exports = { STEPS, STEP_PATHS, DAYS, ALL_DAYS, isOperatingDay, nextStepPath };