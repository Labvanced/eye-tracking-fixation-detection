// include classes
var fixationDetector = require('./fixationDetector');
var loadCSV = require('./load-csv');
var fs = require('fs');
var { convertArrayToCSV } = require('convert-array-to-csv');



////////////// DATA LOADING AND PRE-PROCESSING ///////////////
var task_name = "large_grid";  // loading data for this task only (need to customize)

// defining file paths. 
// NOTE: You can loop over this for instance by changing the subjectNr
var subjectNr = 1
var pathPrefix = './data/'
var pathTrialData = '/trial_data.csv'
var pathTimeSeries = '/timeseries_data.csv'
var filePathTrialData = pathPrefix+subjectNr+pathTrialData

// load trial data CSV file 
// NOTE: The file path is relative to this file. data columns/variable names need to be adjusted per study 
var t_data = loadCSV(filePathTrialData, {
    shuffle: false,
    dataColumns: ['Trial_Nr', 'StartFrame', 'target_visibility_afterTime', 'targetX', 'targetY', 'calibration_error','Task_Name','drift_vector','reactionTime'],
});  
// get the calibration error        
var calib_error = t_data.data[1][5];


// get the time series/ eye tracking data
var filePathTimeSeriesData = pathPrefix+subjectNr+pathTimeSeries
var { data } = loadCSV(filePathTimeSeriesData, {
    shuffle: false,
    dataColumns: ['t', 'x', 'y', 'c', 'Trial_Nr','Task_Name'],
});

// filter time series data for one specified task
var timeseries_data = [];
data.forEach((trial) => {
    if(trial[5]==task_name){
        trial.splice(5,1)
        timeseries_data.push(trial)
    
    }           
})
data = timeseries_data;     
////////////////////////////////////////////////////////////////////////////////


//////////////////// RUNNING FIXATION DETECTION ////////////////////////////////
// initialize fixationDetector instance using the calibration error
var fixationDetector = new fixationDetector.FixationDetector(calib_error);

// initialize array
var fixations = [];

// loop over all gaze points 
for (var i = 0; i < data.length - 1; i++) {
    var input_data = data[i]
    
    // process gaze point, will add more points until a fixation is detected/concluded
    var result = fixationDetector.executeAlgorithm(input_data);
   
    if (result.fixationStatus == "concluded") {
        // save the detected fixation into the fixation array
        var fix_result = {
            "start_time": result.fixationStartTime,
            "end_time": result.fixationEndTime,
            "fixation_duration": result.fixationDuration,
            "X_mean": result.centroidXmean,
            "Y_mean": result.centroidYmean,
            "dispersion": result.dispersion,         
            "conclusionCriteria": result.conclusionCritria,                    
        }                                               
        fixations.push(fix_result);
    }
}
////////////////////////////////////////////////////////////////////////////////

//saving the output in a csv file
var fileOutputPath = pathPrefix +subjectNr +'/fixations_task_'+task_name+'.csv'
var header = ['start_time','end_time','fixation_duration','X_mean','Y_mean','dispersion','conclusionCriteria'];
var fixationCsv = convertArrayToCSV(fixations, {
    header,
    separator: ','
  });
var writeStream = fs.createWriteStream(fileOutputPath);
writeStream.write(fixationCsv);