function maskString(value, visibleStart = 6, visibleEnd = 4, maskChar = '*') {
	if (!value || typeof value !== 'string') return value;
	if (value.length <= visibleStart + visibleEnd) return value;
	const start = value.slice(0, visibleStart);
	const end = value.slice(-visibleEnd);
	return `${start}${maskChar.repeat(value.length - visibleStart - visibleEnd)}${end}`;
}

module.exports = { maskString };