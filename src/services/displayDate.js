// Dates on screen are UK order, like Xero and Xenon: DD/MM/YYYY, and DD/MM/YYYY HH:MM (UK time) for a moment in time.
// Stored data keeps YYYY-MM-DD; only what is shown changes. Anything that is not a date is returned unchanged.
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/;

const UK_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
});

function fromDate(date) {
  if (Number.isNaN(date.getTime())) return '';
  // A Date at exactly midnight UTC is a plain date (how MySQL DATE columns arrive): no time.
  if (date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0) {
    return date.toISOString().slice(0, 10).split('-').reverse().join('/');
  }
  return UK_TIME.format(date).replace(',', '');
}

function ukDate(value) {
  if (value == null || value === '') return value;
  if (value instanceof Date) return fromDate(value);
  const text = String(value).trim();
  const plain = DATE_ONLY.exec(text);
  if (plain) return `${plain[3]}/${plain[2]}/${plain[1]}`;
  if (DATE_TIME.test(text)) {
    // A time stamp with a zone (Z or +hh:mm) is a moment: show it in UK time. Without one it is shown as written.
    if (/(Z|[+-]\d{2}:?\d{2})$/.test(text)) return fromDate(new Date(text));
    const [, y, m, d, hh, mm] = DATE_TIME.exec(text);
    return `${d}/${m}/${y} ${hh}:${mm}`;
  }
  return value;
}

module.exports = { ukDate };
