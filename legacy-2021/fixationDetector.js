// Fixation detector class
class FixationDetector {

    constructor(calib_error) {

        this.calibrationError = calib_error;

        // the factor/multiplier of dispersion change allowed at shortest time (offset)
        this.valueAtMin = 1.6;

        // the time when the added dispersion has to be 0 or less (slope)
        this.timeAtzero = 280;

        // the factor/multiplier for the absolute disperation threshold
        this.dispThresholdFactor = 3.25;

        // minimum samples needed to create a fixation (instead of minimum time)
        this.sampleThresh = 3;

        // maximum allowed time difference in ms between samples (exclusion critaria)
        this.sampleDiffOffset = 150;

        // absolute disperstion threhold is the multiplication of the threshold factor and the individual calibration error
        this.dispThreshold = this.calibrationError * this.dispThresholdFactor


        this.candidateWindow = [];
        this.fixationIsOngoing = false;
        this.nrGazeDropped = 0;
        this.lastFixationStatus = null;

    }


    executeAlgorithm(data) {

        // data is an array with gaze data:
        // position 0: the t timestamp of the gaze point
        // position 1: the x position of the gaze point
        // position 2: the y position of the gaze point
        // position 3: the c confidence of the gaze point


        ////////////// first check if the new point is valid //////////////////////
        // compare data with last entry 
        if (this.candidateWindow.length > 0) {
            var lastGaze = this.candidateWindow[this.candidateWindow.length - 1]
            // check time difference between current and last gaze point. if tiem diff is too large conclude fixation or reset the candidate window
            if (data[0] - lastGaze[0] > this.sampleDiffOffset) {

                if (this.lastFixationStatus == "ongoing") {
                    // if there is a large time difference in an ongoing fixation conclude the fixation and start a new candidate window
                    var returnedFixation = this.concludeFixation("time_difference")
                    this.candidateWindow = [data];
                    return returnedFixation
                } else {
                    // if there is a large time difference in with no current fixation reset the candidate window.
                    this.nrGazeDropped += this.candidateWindow.length
                    this.candidateWindow = [data];
                    if (this.lastFixationStatus == "concluded") {
                        this.lastFixationStatus = "none-detected"
                    }
                    return {
                        fixationStatus: this.lastFixationStatus || "none-detected"
                    };
                }

            }

            // reject point if the point has not changed (same image was used twice) and move to the next point
            var thresh = 0.0001
            if (Math.abs(lastGaze[1] - data[1]) < thresh && Math.abs(lastGaze[2] - data[2]) < thresh) {
                if (this.lastFixationStatus == "concluded") {
                    this.lastFixationStatus = "none-detected"
                }
                this.nrGazeDropped++
                return { fixationStatus: this.lastFixationStatus || "none-detected" }
            }
        }

        /////////// at this point we know the new point is ok / we can use it for a fixation /////////////

        // if we did not gather enough points yet push the current point to candidates and then return 
        var n = this.candidateWindow.length
        if (n <= this.sampleThresh) {
            this.candidateWindow.push(data);
            this.lastFixationStatus = "none-detected";
            return {
                fixationStatus: this.lastFixationStatus
            };
        }


        ///// at this points we should have at least 3 valid points so we can calculate a dispersion
        // check swapping vs. current first (shift and push)
        var dispersionCurrent = this.calcDispersion(this.candidateWindow);
        var arrayPushShift = this.candidateWindow.slice()
        arrayPushShift.push(data);
        arrayPushShift.shift()
        var dispersionPushShift = this.calcDispersion(arrayPushShift);
        var fixationStartTime = this.candidateWindow[0][0];

        // if dispersion is lower for swapping then do it (we remove the first and push the latest point )
        // this operation has precedence over just pushing/adding points
        if (dispersionPushShift < dispersionCurrent) {
            this.nrGazeDropped++
            this.candidateWindow = arrayPushShift

            // check if we reached/keep the dispersion after the swap.
            if (dispersionPushShift < this.dispThreshold) {
                // after the swap the candidate window is or remains to be under the threshold hence we start or continue the fixation
                this.lastFixationStatus = "ongoing";
                this.fixationIsOngoing = true;
                return {
                    fixationStatus: this.lastFixationStatus,
                    fixationStartTime: fixationStartTime
                };
            } // even after the swap the dispersion is still too high to no fixation is yet detected
            else {
                this.lastFixationStatus = "none-detected";
                return {
                    fixationStatus: this.lastFixationStatus,
                };
            }
        }


        // remove gaze or start fixation
        if (dispersionCurrent >= this.dispThreshold) {
            if (this.lastFixationStatus === "ongoing") {
                console.error("Fixation should not be ongoing if dispersion is too large")
                return { fixationStatus: this.lastFixationStatus || "none-detected" }
            }
            // if the current dispersion is too big remove first element and return 
            // this is the normal gaze where we just remove a gaze points due to dispersion. I.e removing saccades
            this.nrGazeDropped++
            this.candidateWindow.shift()
            this.lastFixationStatus = "none-detected";
            return {
                fixationStatus: this.lastFixationStatus
            };
        } else {
            // this is the normal case how a fixation is started or continued. I.e. dispersion is below threshold with at least 3 points.
            this.lastFixationStatus = "ongoing";
            this.fixationIsOngoing = true;
        }


        ////// at this point we can be sure now a fixation was started because we have returned in all other cases //////
        // now the question is to extend or conclude it //
        //calculate relative added dispersion for push operation 
        var arrayPush = this.candidateWindow.slice()
        arrayPush.push(data); // pushed candidate window
        var dispersionPush = this.calcDispersion(arrayPush); // new (absolute) dispersion after push 
        var durationMs = data[0] - this.candidateWindow[0][0]; // ongoing time of the fixation
        var addingThreshold = this.getThreshold(durationMs) // this is the relative dispersion threshold (how much additional dispersion is allowed in percent) calcualed from the ongoiung time of the fixation.
        var addInDispersion = ((dispersionPush - dispersionCurrent) / dispersionCurrent) * 100; // this is the percnt increase of dispersion due to the new point

        // if dispersion is above the absolute threshold conclude the fixation and start new candidate window with current point
        if (addInDispersion > addingThreshold) {
            var returnedFixation = this.concludeFixation("rel_threshold")
            this.candidateWindow = [data];
            return returnedFixation
        } // if dispersion is above the relative threshold conclude the fixation and start new candidate window with current point 
        else if (dispersionPush > this.dispThreshold) {
            var returnedFixation = this.concludeFixation("abs_threshold")
            this.candidateWindow = [data];
            return returnedFixation
        }
        // if relative increase in dispersion and absolute dispersion is below threshold add the new point. This is the normal way to add points to a fixation
        else {
            this.candidateWindow = arrayPush
            return {
                fixationStatus: this.lastFixationStatus,
                fixationStartTime: fixationStartTime
            };
        }
    }



    concludeFixation(reason) {
        // returns the concluded fixation
        var dispersionCurrent = this.calcDispersion(this.candidateWindow);
        var fixationEndTime = this.candidateWindow[this.candidateWindow.length - 1][0]
        var allPointsInFixation = this.candidateWindow.slice()
        var fixationCentroid = this.calcCentroid(this.candidateWindow);
        var fixationStartTime = this.candidateWindow[0][0];
        this.fixationIsOngoing = false;
        this.lastFixationStatus = "concluded";

        if (allPointsInFixation.length < 3) {
            console.error("less than 3 points in the fixation")
            return {}
        }
        else {
            return {
                fixationStatus: this.lastFixationStatus,
                fixationStartTime: fixationStartTime,
                fixationEndTime: fixationEndTime,
                fixationDuration: fixationEndTime - fixationStartTime,
                fixationCentroid: fixationCentroid,
                dispersion: dispersionCurrent,
                centroidXmean: fixationCentroid.xmean,
                centroidYmean: fixationCentroid.ymean,
                gazeData: allPointsInFixation,
                conclusionCritria: reason,
            };
        }

    }


    getThreshold(currentTime) {
        // returns the relative (in percent) allowed dispersion threshold, given the time of the fixation.
        const minTime = 100
        const valueAtMax = -0.5
        const maxTime = 5000

        if (currentTime < minTime) {
            currentTime = minTime
        } else if (currentTime > maxTime) {
            currentTime = maxTime
        }

        var valuePerMs1 = this.valueAtMin / (this.timeAtzero - minTime)
        var valuePerMs2 = valueAtMax / (maxTime - this.timeAtzero)

        if (currentTime < this.timeAtzero) {
            return (this.valueAtMin - ((currentTime - minTime) * valuePerMs1)) * 100
        } else {
            return (((currentTime - minTime) * valuePerMs2)) * 100
        }

    }

    calcCentroid(candidateWindow) {
        //returns the centroid of the fixation
        var xtotal = 0;
        var ytotal = 0;

        for (var i = 0; i < candidateWindow.length; i++) {
            var xcorr = candidateWindow[i][1];
            var ycorr = candidateWindow[i][2];

            // calculate total for x and y
            xtotal += xcorr;
            ytotal += ycorr;
        }
        // // calculate mean for x and y
        var xmean = xtotal / candidateWindow.length;
        var ymean = ytotal / candidateWindow.length;

        return {
            xmean: xmean,
            ymean: ymean
        }
    }

    calcDispersion(candidateWindow) {
        //return the dispersion of the fixation
        var centroid = this.calcCentroid(candidateWindow);
        var centroidxMean = centroid.xmean
        var centroidyMean = centroid.ymean
        // calculate std for x
        var edistanceSum = 0;
        for (var i = 0; i < candidateWindow.length; i++) {
            var xcorr = candidateWindow[i][1];
            var ycorr = candidateWindow[i][2];

            // calc euclidean distance for x corr to y corr to x mean and y mean
            var edistance = Math.sqrt(Math.pow((xcorr - centroidxMean), 2) + Math.pow((ycorr - centroidyMean), 2));
            edistanceSum += edistance;

        }
        return edistanceSum / candidateWindow.length;
    }
}
module.exports.FixationDetector = FixationDetector;
