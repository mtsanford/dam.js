/*
 * Copyright 2012 Mark Sanford. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
 
/**
 * @fileoverview Downloadable Asset Manager (DAM)
 * @author mark@conceptfour.com (Mark Sanford)
 *
 * Public API:
 *
 * DAM(baseDir) create DAM object with a given base directory
 * DAM.init(callback); Initialize a DAM
 * DAM.registerEventCallback(context, callback);
 * DAM.addBundle(bundle)
 * DAM.removeBundle(bundleName)
 * DAM.getBundleNames() returns array of bundle names
 * DAM.getBundle(bundleName) returns a bundle record
 * DAM.bundleLoaded(bundleName) is this bundle loaded?
 * DAM.bundleAdded(bundleName) is this bundle in this.bundles?
 * DAM.localURL(remoteFile) get local URL of a file
 *
 */
 
(function(exports) {

/** Private constants */
var RETRY_INTERVAL = 30000;
    
/**
 * @constructor
 * @param {string} the base directory in which files should be saved relative to root filesystem
 *        Must be empty string or directory name of single depth
 */
var DAM = function(baseDir) {
  if (!baseDir) baseDir = '';
  
  // These are all "private" variables and should not be altered by the client
  this.fileSystem = null;
  this.directoryEntry = null;
  this.baseDir = baseDir;
  this.bundlesKey = "bundles_" + baseDir;
  this.bundles = {};
  this.localURLs = {};
  this.tasks = [];
  this.doingTasks = false;
  
  this.eventCallbacks = [];
  this.eventQueue = [];
  this.eventTimer = null;
};

/** Class constants */
DAM.GLOBAL_EVENT_BUSY = 'busy';
DAM.GLOBAL_EVENT_NOTBUSY = 'notbusy';

DAM.BUNDLE_EVENT_LOADING = 'loading';
DAM.BUNDLE_EVENT_PROGRESS = 'progress';
DAM.BUNDLE_EVENT_LOADED = 'loaded';
DAM.BUNDLE_EVENT_ERROR = 'error';

/**
 * Register a callback when bundle or global events happen.   Callbacks are guaranteed
 * to be asynchronous, so a call to a function in the DAM will not result in a callback
 * before the function returns.
 *
 * Bundle Events:
 *
 *  {event: DAM.BUNDLE_EVENT_LOADING, name:'bundleName'} when bundle starts loading
 *  {event: DAM.BUNDLE_EVENT_PROGRESS, name:'bundleName', done:0.5} when bundle load progress happens
 *  {event: DAM.BUNDLE_EVENT_LOADED, name:'bundleName'} when bundle finishes loading
 *  {event: DAM.BUNDLE_EVENT_ERROR, name:'bundleName', error:'what happened'} when bundle cannot be loaded
 *
 * Global events: 
 *
 *  {event: DAM.GLOBAL_EVENT_BUSY} a download or remove task is in progress
 *  {event: DAM.GLOBAL_EVENT_NOTBUSY} no task in progress
 *
 * @param {object} Callback "this" context.  Can be null.
 * @param {function} The callback function
 */
DAM.prototype.registerEventCallback = function(context, callback) {
  this.eventCallbacks.push({context:context, callback:callback});
}

/**
 * @private
 * Send an event asynchronously to listeners
 * @param {object} DAM object
 * @param {object} event to send to listeners
 */
function _sendEvent(manager, event) {

  // ensure that we're not sending any events syncronously with client calls, since calls like init,
  // and addBundle can cause events to fire, causing hard to track down bugs in the client.
  // We cannot rely on multiple JS timers of 0 duration to fire in order, so set up a queue.
  manager.eventQueue.push(event);
  
  if (manager.eventTimer == null) {
    manager.eventTimer = setTimeout(function() {
      for (var m=0; m < manager.eventQueue.length; m++) {
        for (var i=0; i < manager.eventCallbacks.length; i++) {
          manager.eventCallbacks[i].callback.call(manager.eventCallbacks[i].context, manager.eventQueue[m]);
        }
      }
      manager.eventTimer = null;
      manager.eventQueue = [];
    }, 0);
  }

}

/**
 * @private
 * Clear any pending events for a bundle that have not been sent yet.
 * @param {object} DAM object
 * @param {object} message to send to listeners
 */
function _purgeEvents(manager, bundleName) {
  for (var i=0; i < manager.eventQueue.length; /* no increment */ ) {
    if (manager.eventQueue[i].name == bundleName) {
      manager.eventQueue.splice(i,1);
    } else {
      i++;
    }
  }
}

/**
 * Initializes DAM.   Checks file status for all bundle files to confirm loaded status.
 * Initiates download of bundles that are not loaded yet.   DAM.BUNDLE_EVENT_LOADED events
 * will be fired for all bundles that are loaded.
 * @param {function} callback ( {success:true} or {success:false, error:"what happened"} )
 */
DAM.prototype.init = function(callback) {
  var that = this;
  
  this.bundles = JSON.parse(localStorage.getItem(this.bundlesKey));
  if (this.bundles == null) this.bundles = {};
  
  window.requestFileSystem(LocalFileSystem.PERSISTENT, 0, function(fileSystem) {
    that.fileSystem = fileSystem;
    if (that.baseDir.length > 0) {
      that.fileSystem.root.getDirectory(that.baseDir, {create: true, exclusive: false}, _haveDirectoryEntry, function(err) {
          callback({success:false, error:"Could not create directory " + that.baseDir + " FileError code: " + err.code});
      });
    } else {
      _haveDirectoryEntry(that.fileSystem.root);
    }
  }, function (err) {
    callback({success:false, error:"Could not get file system.  FileError code: " + err.code});
  });
  
  function _haveDirectoryEntry(entry) {
    that.directoryEntry = entry;
    _checkBundleLoadStatusAll(that, function(status) {
      if (status.success) {
        for (var bundleName in that.bundles) {
          var bundle = that.bundles[bundleName];
          if (bundle.loaded == false) {
            _maybeAddTask(that, bundle.name, Task.TASK_TYPE_LOAD);
          } else {
            _sendEvent(that, {event:DAM.BUNDLE_EVENT_LOADED, name:bundle.name});
          }
		}
   
        // Retry failed tasks once in a while
        // TODO do on regaining network connectivity?
        setInterval(kickStartTasks, RETRY_INTERVAL);
  
        callback({success:true});
      } else {
        callback(status);
      }
    });
  }

  function kickStartTasks() {
    for (var i=0; i<that.tasks.length; i++) {
      task = that.tasks[i];
      if (task.canceled == false && task.failed == true && task.retry == true) {
	    task.failed = false;
	    task.retry = false;
	  }
    }
    _doTasks(that); 
  }
  
};

  /**
   * For debugging.  Needed to avoid circular references which JSON.stringify does not like
   */
  function _reportTasks(manager, msg) {
    var out = msg + ' tasks:';
    for (var i=0; i < manager.tasks.length; i++) {
      var copy = { bundleName : manager.tasks[i].bundleName, failed : manager.tasks[i].failed, retry : manager.tasks[i].retry };
      out += '\n' + JSON.stringify(copy);
    }
    console.log(out);
  }

/**
 * @private
 * Check the load status of all bundles by confirming files exist.
 * @param {object} DAM object
 * @param {function} callback
 */
function _checkBundleLoadStatusAll(manager, callback) {
  var allLoaded = true;
  var allSuccess = true;
  var bundlenames = [];
  for (var name in manager.bundles) {
    bundlenames.push(name);
  }
  (function loop(index) {
    if (index == bundlenames.length) {
      localStorage.setItem(manager.bundlesKey, JSON.stringify(manager.bundles));
      callback({success: allSuccess, loaded:allLoaded});
      return;
    }
    var bundle = manager.bundles[bundlenames[index]];
    _checkBundleLoadStatus(manager, bundle, function(status) {
      bundle.loaded = status.loaded;
      allLoaded = allLoaded && status.loaded;
      allSuccess = allSuccess && status.success;
      loop(index + 1);
    });
  })(0);
}

/**
 * @private
 * Check the load status of a bundle by confirming files exist.
 * @param {object} DAM object
 * @param {object} bundle object
 * @param {function} callback after complete
 */
function _checkBundleLoadStatus(manager, bundle, callback) {
  (function loop(index) {
    if (index == bundle.files.length) {
      callback({success:true, loaded:true});
      return;
    }
    var localName = _localFileName(bundle.files[index]);
    manager.directoryEntry.getFile(localName, {create: false, exclusive: false}, function(fileEntry) {
      _addLocalURL(manager, bundle.files[index], fileEntry);
      loop(index + 1);
    }, function(err) {
      // TODO handle different errors.  Right now we assume error just means file doesn't exist
      callback({success:true, loaded:false});
    });
  })(0);
}

/**
 * @return {array} of bundle names
 */
DAM.prototype.getBundleNames = function() {
  var bundles = [];
  for (bundleName in this.bundles) {
    bundles.push(bundleName);    
  }
  return bundles;
};

/**
 * Returns a copy of a bundle record
 * @param {string} the name of the bundle to check
 * @return {object} a bundle record (copy)
 */
DAM.prototype.getBundle = function(bundleName) {
  return this.bundles.hasOwnProperty(bundleName) ? _copyBundle(this.bundles[bundleName]) : undefined;
};

/**
 * Check if bundle exists
 * @param {string} the name of the bundle to check
 * @return {boolean} if the bundle exists
 */
DAM.prototype.bundleAdded = function(bundleName) {
  return this.bundles.hasOwnProperty(bundleName);
};

/**
 * Check the loaded state of a bundle
 * @param {string} the name of the bundle to check
 * @return {boolean} if the bundle exists & is loaded
 */
DAM.prototype.bundleLoaded = function(bundleName) {
  return this.bundles.hasOwnProperty(bundleName) ?  this.bundles[bundleName].loaded : false;
};

/**
 * Get the local URL of the downloaded asset based on the remote URL in the bundle
 * @param {string} the remote URL
 * @return {boolean} the local URL
 */
DAM.prototype.localURL = function(remoteFile) {
  return this.localURLs[remoteFile];
}

/**
 * Add a bundle. Added to DAM objects bundle list immediately with load=false
 * Note that a copy of the passed in bundle is added to the DAM's bundle list.
 * Downloading is started immediately.
 * 
 * Example bundle:
 *
 * { 
 *   name : "bundle1",
 *   files : [ "http://example.com/image1.jpg", "http://example.com/image1.jpg"],
 *   fileSizes : [ 150543, 459044 ]
 * }
 *
 * filesSizes is optional, and serves only to give more accurate progress events.
 *
 * @param {object} the bundle to add
 * @throws {string} if the bundle is malformed
 */
DAM.prototype.addBundle = function(bundle) {
  // Care must be taken not to let the client add malformed bundles, or the DAM
  // can become crippled
  if (_malformedBundle(bundle)) throw "Malformed bundle passed to addBundle";
  
  var bundleName = bundle.name;
  
  if (this.bundles.hasOwnProperty(bundleName)) return;
  
  var copy = _copyBundle(bundle);
  copy.loaded = false;
  this.bundles[bundleName] = copy;
  localStorage.setItem(this.bundlesKey, JSON.stringify(this.bundles));
  _cancelTask(this, bundleName, Task.TASK_TYPE_REMOVE);
  _maybeAddTask(this, bundleName, Task.TASK_TYPE_LOAD);
};

  function _malformedBundle(bundle) {
    if (      typeof(bundle) != 'object'
          ||  typeof(bundle.name) != 'string'
          ||  _isArray(bundle.files) == false )
        return true;
    for (var i=0; i<bundle.files.length; i++) {
      if (typeof bundle.files[i] != 'string') return true;
    }
    if (typeof(bundle.fileSizes) != 'undefined'
        && (_isArray(bundle.fileSizes) == false || bundle.fileSizes.length != bundle.files.length) ) {
        return true;
    }
    return false;
  }
  
  function _copyBundle(bundle) {
    var copy = { name : bundle.name, files : bundle.files.slice() }
    if (bundle.fileSizes) { copy.fileSizes = bundle.fileSizes.slice(); }
    return copy;
  }

  function _isArray(o) { return Object.prototype.toString.call(o) === '[object Array]' }

/**
 * Remove a bundle.  Bundle is removed immediately from the DAM's bundle list.
 * Client will not receive any events for this bundle after calling removeBundle.
 * @param {string} the name of the bundle to remove
 */
DAM.prototype.removeBundle = function(bundleName) {
  if (this.bundles.hasOwnProperty(bundleName)) {
    var removedBundle = this.bundles[bundleName];
    delete this.bundles[bundleName];
    localStorage.setItem(this.bundlesKey, JSON.stringify(this.bundles));
    _cancelTask(this, bundleName, Task.TASK_TYPE_LOAD);
	_maybeAddTask(this, bundleName, Task.TASK_TYPE_REMOVE, removedBundle);
  }
}

/**
 * @private
 * Add a task to the tasks queue.   If a task already exists with the
 * same bundle and type, don't add a new one.
 * @param {object} DAM
 * @param {string} name of the bundle
 * @param {string} type of task
 * @param {object} extra data specific to the task
 */
function _maybeAddTask(manager, bundleName, type, extra) {
  if(typeof(extra)==='undefined') extra = {};
  
  for (var i=0; i < manager.tasks.length; i++) {
    if (manager.tasks[i].bundleName == bundleName && manager.tasks[i].type == type && manager.tasks[i].canceled == false) {
      return;
    }
  }
  
  var newTask = new Task(manager, bundleName, type, extra);  
  manager.tasks.push(newTask);
  _doTasks(manager);
}

/**
 * @private
 * Cancel a task. (e.g. If we're downloading a bundle, and then it's removed
 * there is no sense in continuing the download.)
 * @param {object} DAM
 * @param {string} name of the bundle
 * @param {string} type of task
 */
function _cancelTask(manager, bundleName, type) {
  // Important: NEVER remove a task.  That is a responsibility of the doTask() function.
  // Just mark it as canceled, and the task handler will notice when it completes
  // an asynchronous task, and doTask() will clean it up.
  for (var i=0; i < manager.tasks.length; i++) {
    if (manager.tasks[i].bundleName == bundleName && manager.tasks[i].type == type) {
      manager.tasks[i].abort();
    }
  }
}

/**
 * @private
 * Do all tasks in order.
 * @param {object} DAM object
 */
function _doTasks(manager) {
  if (manager.doingTasks) return;
  
  (function loop() {
    var i;
    
    // Removed canceled tasks first
    for (i=0; i < manager.tasks.length; /*no increment */) {
      if (manager.tasks[i].canceled == true) {
        manager.tasks.splice(i,1);
      } else {
        i++;
      }
    }
  
    // Now look for a non-failed task to do
    var task = null;
    for (i=0; i < manager.tasks.length; i++) {
      if (manager.tasks[i].failed == false) {
        task = manager.tasks[i];
        break;
      }
    }
    
    if (task == null) {
      if (manager.doingTasks) {
        manager.doingTasks = false;
        _sendEvent(manager, {event:DAM.GLOBAL_EVENT_NOTBUSY});
      }
      return;
    }
    
    if (manager.doingTasks == false) {
      manager.doingTasks = true;
      _sendEvent(manager, {event:DAM.GLOBAL_EVENT_BUSY});
    }

    task.doIt(onComplete);
    
    function onComplete() {
      if (task.canceled) {
        // will get cleaned up on loop
      } else if (task.failed) {
        if (task.retry == false) manager.tasks.splice(i,1);
      } else {
        manager.tasks.splice(i,1);
      }
      loop();
    }
  })();
}

  /***********************************************
      tiny-sha1 r4
      MIT License
      http://code.google.com/p/tiny-sha1/
   ***********************************************/
  function SHA1(s){function U(a,b,c){while(0<c--)a.push(b)}function L(a,b){return(a<<b)|(a>>>(32-b))}function P(a,b,c){return a^b^c}function A(a,b){var c=(b&0xFFFF)+(a&0xFFFF),d=(b>>>16)+(a>>>16)+(c>>>16);return((d&0xFFFF)<<16)|(c&0xFFFF)}var B="0123456789abcdef";return(function(a){var c=[],d=a.length*4,e;for(var i=0;i<d;i++){e=a[i>>2]>>((3-(i%4))*8);c.push(B.charAt((e>>4)&0xF)+B.charAt(e&0xF))}return c.join('')}((function(a,b){var c,d,e,f,g,h=a.length,v=0x67452301,w=0xefcdab89,x=0x98badcfe,y=0x10325476,z=0xc3d2e1f0,M=[];U(M,0x5a827999,20);U(M,0x6ed9eba1,20);U(M,0x8f1bbcdc,20);U(M,0xca62c1d6,20);a[b>>5]|=0x80<<(24-(b%32));a[(((b+65)>>9)<<4)+15]=b;for(var i=0;i<h;i+=16){c=v;d=w;e=x;f=y;g=z;for(var j=0,O=[];j<80;j++){O[j]=j<16?a[j+i]:L(O[j-3]^O[j-8]^O[j-14]^O[j-16],1);var k=(function(a,b,c,d,e){var f=(e&0xFFFF)+(a&0xFFFF)+(b&0xFFFF)+(c&0xFFFF)+(d&0xFFFF),g=(e>>>16)+(a>>>16)+(b>>>16)+(c>>>16)+(d>>>16)+(f>>>16);return((g&0xFFFF)<<16)|(f&0xFFFF)})(j<20?(function(t,a,b){return(t&a)^(~t&b)}(d,e,f)):j<40?P(d,e,f):j<60?(function(t,a,b){return(t&a)^(t&b)^(a&b)}(d,e,f)):P(d,e,f),g,M[j],O[j],L(c,5));g=f;f=e;e=L(d,30);d=c;c=k}v=A(v,c);w=A(w,d);x=A(x,e);y=A(y,f);z=A(z,g)}return[v,w,x,y,z]}((function(t){var a=[],b=255,c=t.length*8;for(var i=0;i<c;i+=8){a[i>>5]|=(t.charCodeAt(i/8)&b)<<(24-(i%32))}return a}(s)).slice(),s.length*8))))}
  /***********************************************/

  /**
   * Helper function to get the local file name based on an asset's uri
   * Preserves the file extension, if there is one
   * @param {String} the remote URI of the file to store locally 
   */
  function _localFileName(uri) {
    var l = uri.lastIndexOf('.');
    return SHA1(uri) + ((l < 1 || l == uri.length - 1) ? '' : uri.substr(l));
  }
        
  function _addLocalURL(manager, remoteURL, fileEntry) {
    if(manager.localURLs.hasOwnProperty(remoteURL) == false) {
      manager.localURLs[remoteURL] = fileEntry.toURL();
    }
  }

  function _removeLocalURL(manager, remoteURL) {
    if(manager.localURLs.hasOwnProperty(remoteURL)) {
      delete manager.localURLs[remoteURL];
    }
  }


/**
 * @private
 * Task object to encapsulate a DAM task
 */

function Task(manager, bundleName, type, extra) {
  this.manager = manager;
  this.bundleName = bundleName;
  this.type = type;
  this.extra = extra;
  this.failed = false;
  this.error = false;
  this.canceled = false;
  this.retry = false;
}

Task.TASK_TYPE_LOAD = 'load';
Task.TASK_TYPE_REMOVE = 'remove';
  
Task.prototype.doIt = function(callback) {
  if (this.type == Task.TASK_TYPE_LOAD) {
    _downloadBundle(this, callback);
  } else if (this.type == Task.TASK_TYPE_REMOVE) {
    _removeBundleFiles(this, callback);
  }
}
  
Task.prototype.abort = function(callback) {
  this.canceled = true;
  if (this.ft) {
    this.ft.abort();
  }
  _purgeEvents(this.manager, this.bundleName);
}
   
/**
 * @private
 * Download a bundle of files
 * @param {object} the task object
 * @param {function} callback after complete
 */
function _downloadBundle(task, callback) {
  var manager = task.manager,
      bundle = manager.bundles[task.bundleName],
      totalSize = 0, totalDoneSize = 0;

  // If the bundle has fileSizes defined, use those numbers, otherwise
  // each file is considered equally toward progress
  if (bundle.fileSizes) {
    for (var i=0; i<bundle.fileSizes.length; i++) totalSize += bundle.fileSizes[i];
  } else {
    totalSize = bundle.files.length;
  }

  _sendEvent(manager, {event:DAM.BUNDLE_EVENT_LOADING, name:bundle.name});
  
  (function loop(index) {
    if (task.canceled) {
      return error("canceled", false);
    }
    
    if (index == bundle.files.length) {
      bundle.loaded = true;
      localStorage.setItem(manager.bundlesKey, JSON.stringify(manager.bundles));
      _sendEvent(manager, {event:DAM.BUNDLE_EVENT_LOADED, name:bundle.name});
      callback();
      return;
    }
    
    var remoteFile = bundle.files[index];
    var localName = _localFileName(remoteFile);
    manager.directoryEntry.getFile(localName, {create: false, exclusive: false}, function(fileEntry) {
      if (!task.canceled) {
          totalDoneSize += bundle.fileSizes ? bundle.fileSizes[index] : 1;
          _sendEvent(manager, {event:DAM.BUNDLE_EVENT_PROGRESS, name:bundle.name, done: totalDoneSize / totalSize });
      }
      loop(index + 1);
    }, function(err) {
      manager.directoryEntry.getFile(localName, {create: true, exclusive: false}, function(fileEntry) {
        var localPath = fileEntry.fullPath;
        
        task.ft = new FileTransferWrapper(manager.filesytem);
        
        task.ft.onprogress = function(e) {
          if (e.lengthComputable && !task.canceled) {
            var extraDone = (e.loaded / e.total) * ( bundle.fileSizes ? bundle.fileSizes[index] : 1 );
            _sendEvent(manager, {event:DAM.BUNDLE_EVENT_PROGRESS, name:bundle.name, done: (totalDoneSize + extraDone) / totalSize });
          }
        }
        
        task.ft.download(remoteFile, localPath, _downloadSuccess, _downloadFail);
        
        function _downloadSuccess(fileEntry) {
          delete task.ft;
          _addLocalURL(manager, remoteFile, fileEntry);
          if (!task.canceled) {
            totalDoneSize += bundle.fileSizes ? bundle.fileSizes[index] : 1;
            _sendEvent(manager, {event:DAM.BUNDLE_EVENT_PROGRESS, name:bundle.name, done: totalDoneSize / totalSize});
          }
          loop(index + 1);
        }

        function _downloadFail(err) {
          delete task.ft;
          fileEntry.remove();
          if (err.code == FileTransferError.ABORT_ERR) {
            callback();
          } else {
            // TODO There appears to be an intermitent bug in phonegap's download: if network connectivity is lost
            // the fail callback can be called with an http_status of 200, which indicates success.
            var retry = !err.http_status || err.http_status == 200;
            error("FileTransferError: " + JSON.stringify(err), retry);
          }
        }
        
      }, function (err) {
        error("Unable to create file for download FileError code: " + err.code);
      });
        
    });
  })(0);

  function error(errorStr, retry) {
    if (typeof(retry) == 'undefined') retry = false;
    console.log(errorStr);
    task.failed = true;
    task.error = errorStr;
    task.retry = retry;
    if (task.retry == false && task.canceled == false) {
      _sendEvent(manager, {event:DAM.BUNDLE_EVENT_ERROR, name:bundle.name, error:errorStr});
    }
    callback();
  }
}
    
/**
 * @private
 * @param {object} DAM object
 * @param {object} the task object
 * @param {function} callback
 */
function _removeBundleFiles(task, callback) {
  var manager = task.manager,
      bundle = task.extra;
      
  (function loop(index) {
    if (task.canceled || index == bundle.files.length) {
      callback();
      return;
    }

    var fileName = bundle.files[index];
    var localFileName = _localFileName(fileName);
    
    // skip if any other bundle is referencing this file
    for (var bName in manager.bundles) {
      if (bName == bundle.name) continue;
      var files = manager.bundles[bName].files;
      for (var findex = 0; findex < files.length; findex++) {
        if (files[findex] == fileName) {
          loop(index + 1);
          return;
        }
      }   
    }
    
    // Delete the file
    // Seems that deleting a file will ALWAYS generate an error, so just ignore it
    // http://comments.gmane.org/gmane.comp.handhelds.phonegap/27080
    manager.directoryEntry.getFile(localFileName, {create: false, exclusive: false}, function(fileEntry) {
      fileEntry.remove(next, next);
      _removeLocalURL(manager, fileName);
    }, next);
    
    function next() { loop(index + 1); }

  })(0);    
}


/**
 * @private
 * FileTransferWrapper is a wrapper class for the phonegap FileTransfer. It has 2 purposes:
 *   - enforce our own timeout
 *   - (future) provide phonegap v2.2 FileTransfer-like interface to XHR2 + FileWriter
 */
 
function FileTransferWrapper(filesytem) {
  this.isCordova = (typeof(cordova) !== 'undefined' || typeof(phonegap) !== 'undefined');
  this.filesytem = filesytem;
}
  
/**
 *  FileTransfer.download() does not fire error callback sometimes when network
 *  connection is lost.   No timeout.  No nothing.   We *need* a callback 
 *  to keep our task queue going, so enforce our own timeout.
 */
FileTransferWrapper.ENFORCE_DOWNLOAD_TIMEOUT = true;
FileTransferWrapper.DOWNLOAD_TIMEOUT = 30000;
    
FileTransferWrapper.prototype.download = function(uri, localPath, success_callback, error_callback) {
  this.uri = uri;
  this.localPath = localPath;
  this.success_callback = success_callback;
  this.error_callback = error_callback;
    
  return _cordova_download(this);
}
    
FileTransferWrapper.prototype.abort = function() {
    return this.ft.abort();
}

function _cordova_download(context) {
  var timed_out = false,
      timeout_id = undefined;
        
  if (FileTransferWrapper.ENFORCE_DOWNLOAD_TIMEOUT) {
    timeout_id = setTimeout(timeout, FileTransferWrapper.DOWNLOAD_TIMEOUT);
  }
  context.ft = new FileTransfer();
  if (context.onprogress) context.ft.onprogress = function(e) {
    if (!timed_out) {
      // When we get a progress event, reset the timeout
      if (FileTransferWrapper.ENFORCE_DOWNLOAD_TIMEOUT) {
        clearTimeout(timeout_id);
        timeout_id = setTimeout(timeout, FileTransferWrapper.DOWNLOAD_TIMEOUT);
      }
      context.onprogress(e);
    }
  }
  context.ft.download(context.uri, context.localPath, function(fileEntry) {
    if (!timed_out) {
      clearTimeout(timeout_id);
      context.success_callback(fileEntry);
    }
  }, function(err) {
    if (!timed_out) {
      clearTimeout(timeout_id);
      context.error_callback(err);
    }
  });
  
  function timeout() {
    timed_out = true;
    timeout_id = undefined;
    var err = new FileTransferError(FileTransferError.CONNECTION_ERR, context.uri, context.localPath, null);
    context.error_callback(err);
  }
}

exports.DAM = DAM;

})(window);

