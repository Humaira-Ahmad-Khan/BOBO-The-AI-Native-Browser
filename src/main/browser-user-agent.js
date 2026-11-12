'use strict';

function browserUserAgent(value, product) {
  const escaped = product.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return value
    .replace(/\sElectron\/[^\s]+/gi, '')
    .replace(new RegExp('\\s' + escaped + '/[^\\s]+', 'gi'), '')
    .trim();
}

module.exports = { browserUserAgent };
