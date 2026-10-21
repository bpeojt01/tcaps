// Travel request form definition, shared by the public form view and server-side validation.
const F = (k, label, type = 'text', o = {}) => ({ k, label, type, ...o });
const CLASSES = ['Economy', 'Premium Economy', 'Business', 'First'];

const GROUPS = {
  flight: {
    types: ['Domestic flight', 'International flight'],
    fields: [
      F('trip_type', 'Trip type', 'select', { options: ['One-way', 'Round-trip'], required: true }),
      F('origin', 'Departure location', 'text', { required: true }),
      F('destination', 'Destination', 'text', { required: true }),
      F('depart_date', 'Departure date', 'date', { required: true }),
      F('return_date', 'Return date', 'date', { when: 'Round-trip' }),
      F('travelers', 'Number of travelers', 'number', { required: true, min: 1, max: 99 }),
      F('adults', 'Adults', 'number', { min: 0, max: 99 }),
      F('children', 'Children', 'number', { min: 0, max: 99 }),
      F('airline', 'Preferred airline (optional)'),
      F('travel_class', 'Preferred travel class', 'select', { options: CLASSES }),
      F('notes', 'Additional requirements', 'textarea'),
    ],
  },
  hotel: {
    types: ['Hotel reservation'],
    fields: [
      F('destination', 'Destination or preferred hotel', 'text', { required: true }),
      F('check_in', 'Check-in date', 'date', { required: true }),
      F('check_out', 'Check-out date', 'date', { required: true }),
      F('guests', 'Number of guests', 'number', { required: true, min: 1, max: 99 }),
      F('rooms', 'Number of rooms', 'number', { required: true, min: 1, max: 50 }),
      F('room_type', 'Preferred room type', 'text'),
      F('notes', 'Additional requirements', 'textarea'),
    ],
  },
  package: {
    types: ['Travel package'],
    fields: [
      F('destination', 'Destination', 'text', { required: true }),
      F('depart_date', 'Preferred departure date', 'date', { required: true }),
      F('return_date', 'Preferred return date', 'date'),
      F('travelers', 'Number of travelers', 'number', { required: true, min: 1, max: 99 }),
      F('budget', 'Estimated budget (₱, optional)', 'number', { min: 0 }),
      F('inclusions', 'Desired inclusions (flights, hotel, tours…)', 'textarea'),
      F('notes', 'Additional requirements', 'textarea'),
    ],
  },
  group: {
    types: ['Group booking'],
    fields: [
      F('destination', 'Destination', 'text', { required: true }),
      F('depart_date', 'Preferred departure date', 'date', { required: true }),
      F('return_date', 'Preferred return date', 'date'),
      F('group_size', 'Group size', 'number', { required: true, min: 2, max: 999 }),
      F('group_type', 'Type of group (family, company, church…)'),
      F('needs', 'Services needed (flights, hotel, transfers…)', 'textarea'),
      F('notes', 'Additional requirements', 'textarea'),
    ],
  },
  other: {
    types: ['Other travel service'],
    fields: [
      F('description', 'What do you need help with?', 'textarea', { required: true }),
      F('preferred_date', 'Preferred date (optional)', 'date'),
      F('notes', 'Additional requirements', 'textarea'),
    ],
  },
};
const groupOf = (type) => Object.entries(GROUPS).find(([, g]) => g.types.includes(type));
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

// Returns { details, errors } for the given service type and raw body values (prefixed "d_").
function parseDetails(type, body) {
  const g = groupOf(type);
  if (!g) return { details: {}, errors: { service_type: 'Choose a service.' } };
  const details = {}, errors = {};
  const trip = body.d_trip_type;
  for (const f of g[1].fields) {
    let v = String(body['d_' + f.k] ?? '').trim();
    const need = f.required || (f.when && trip === f.when && f.k === 'return_date');
    if (!v) { if (need) errors[f.k] = 'Required.'; continue; }
    if (v.length > 2000) v = v.slice(0, 2000);
    if (f.type === 'date' && !isDate(v)) errors[f.k] = 'Enter a valid date.';
    else if (f.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n) || (f.min != null && n < f.min) || (f.max != null && n > f.max)) errors[f.k] = 'Enter a valid number.';
      else v = String(n);
    } else if (f.type === 'select' && !f.options.includes(v)) errors[f.k] = 'Invalid choice.';
    if (!(f.k === 'return_date' && g[0] === 'flight' && trip !== 'Round-trip')) details[f.k] = v;
  }
  const dep = details.depart_date || details.check_in, ret = details.return_date || details.check_out;
  if (dep && ret && !errors.return_date && !errors.check_out && ret < dep) errors[details.check_out ? 'check_out' : 'return_date'] = 'Must not be before the start date.';
  return { details, errors };
}
const labelOf = (type) => Object.fromEntries((groupOf(type)?.[1].fields || []).map((f) => [f.k, f.label]));

module.exports = { GROUPS, groupOf, parseDetails, labelOf };
