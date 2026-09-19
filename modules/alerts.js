const ALERT_KEYWORDS = [
  'state of emergency',
  'emergency declared',
  'mandatory evacuation',
  'evacuation order',
  'mass casualty',
  'shooting',
  'explosion',
  'bomb',
  'terror',
  'attack',
  'hostage',
  'wildfire',
  'tornado',
  'hurricane',
  'earthquake',
  'flood warning',
  'flash flood',
  'tsunami',
  'landslide',
  'hazmat',
  'radiation',
  'nuclear'
];

export function isAlertItem(item) {
  if (!item) return false;
  if (item.alertType || item.severity || item.hazardType) return true;
  if (Number.isFinite(item.magnitude) && item.magnitude >= 6) return true;
  if (Number.isFinite(item.fatalities) && item.fatalities >= 10) return true;
  if (Number.isFinite(item.impactScore) && item.impactScore >= 80) return true;
  const text = [
    item.title,
    item.summary,
    item.summaryHtml,
    item.detailSummary,
    item.detailTitle
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return ALERT_KEYWORDS.some((keyword) => text.includes(keyword));
}
