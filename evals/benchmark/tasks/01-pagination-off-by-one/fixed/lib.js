function paginate(rows, page, pageSize, total) {
  const start = (page - 1) * pageSize;
  const end = Math.min(start + pageSize, total);
  return rows.slice(start, end);
}

module.exports = { paginate };
