const fs = require('fs');
const _ = require('lodash');

function extractColumns(data, columnNames) {
  var headers = _.first(data);

  // remove the quotes from the beginning and end of the header cells:
  headers = _.map(headers, column => column.replace(/^"+|"+$/gm,''));

  const indexes = _.map(columnNames, column => headers.indexOf(column));

  // if columnNames contains integers, we directly use them as column index:
  for (let i = 0; i < columnNames.length; i++) {
    if (typeof columnNames[i] != "string") {
      indexes[i] = columnNames[i];
    }
  }

  const extracted = _.map(data, row => _.pullAt(row, indexes));

  return extracted;
}

module.exports = function loadCSV(
  filename,
  {
    dataColumns = [],
    labelColumns = [],
    converters = {},
    shuffle = false,
    splitTest = false
  }
) {
  let data = fs.readFileSync(filename, { encoding: 'utf-8' });
  data = _.map(data.split('\n'), d => d.split(','));
  data = _.dropRightWhile(data, val => _.isEqual(val, ['']));
  const headers = _.first(data);

  data = _.map(data, (row, index) => {
    if (index === 0) {
      return row;
    }
    return _.map(row, (element, index) => {
      if (converters[headers[index]]) {
        const converted = converters[headers[index]](element);
        return _.isNaN(converted) ? element : converted;
      }
      
      if (element.indexOf(";")>=0){
        var array = element.split(";")
        var result = []
        array.forEach(elem=>{
          result.push(parseFloat(elem.replace('"', '')))
        })
      }
      else{
        var result = parseFloat(element.replace('"', ''));
      }
     

      return _.isNaN(result) ? element.replace(/^"+|"+$/gm,'') : result;
    });
  });

  let labels = extractColumns(data, labelColumns);
  data = extractColumns(data, dataColumns);

  data.shift();
  labels.shift();

  if (splitTest) {
    const trainSize = _.isNumber(splitTest)
      ? splitTest
      : Math.floor(data.length / 2);

    return {
      data: data.slice(trainSize),
      labels: labels.slice(trainSize),
      testFeatures: data.slice(0, trainSize),
      testLabels: labels.slice(0, trainSize)
    };
  } else {
    return { data: data };
  }
};
