

// Some random images who's server does not mind cross-server request
var files = [
    "http://data-gov.tw.rpi.edu/w/images/thumb/4/41/Gcn1030.png/280px-Gcn1030.png",
    "http://data-gov.tw.rpi.edu/w/images/thumb/e/e0/Castnet.jpg/280px-Castnet.jpg",
    "http://data-gov.tw.rpi.edu/images/logo-data-gov.png",
    "http://data-gov.tw.rpi.edu/w/images/thumb/d/d4/Successful_Demo_Screenshot.png/800px-Successful_Demo_Screenshot.png",
    "http://upload.wikimedia.org/wikipedia/commons/thumb/c/cc/Joe_Biden_official_portrait_crop.jpg/220px-Joe_Biden_official_portrait_crop.jpg",
    "http://data-gov.tw.rpi.edu/w/images/thumb/a/a4/Data-gov-rss.png/150px-Data-gov-rss.png",
    "http://data-gov.tw.rpi.edu/w/images/thumb/d/d6/Demo-1148_1623.png/150px-Demo-1148_1623.png",
    "http://data-gov.tw.rpi.edu/w/images/thumb/d/d6/BAD-FILE-THAT-DOESNT-EXIST.png",  // <-- bad
    "http://upload.wikimedia.org/wikipedia/commons/6/65/PCB_Spectrum.jpg",
    "http://upload.wikimedia.org/wikipedia/commons/thumb/6/66/Drawing-1.png/1074px-Drawing-1.png",
    "http://upload.wikimedia.org/wikipedia/commons/thumb/d/dc/Mosquito_2007-2.jpg/1144px-Mosquito_2007-2.jpg",
];

var sizes = [92500, 30600, 15600, 357000, 15600, 30000, 24600, 40000, 31800, 770400, 162300];

// will be properly filled in later
var bundles = {
    b012: { name : 'b012', files : [0,1,2] },
    b3456: { name : 'b3456', files : [3,4,5,6], fileSizes:true },
    b0123456: { name : 'b0123456', files : [0,1,2,3,4,5,6], fileSizes:true },
    bigbundle: { name : 'bigbundle', files : [8,9,10], fileSizes:true },
    badBundle: { name : 'badBundle', files : [0,7] }  // files[7] generates 404
};

document.addEventListener("deviceready", onDeviceReady, false);

function onDeviceReady() {

    for (var bundleName in bundles) {
        var bundle=bundles[bundleName];
        
        // fill in bundles with proper data
        if (bundle.files) {
          var newFiles = [];
          var newSizes = [];
          for (var i=0; i<bundle.files.length; i++) {
            newFiles[i] = files[bundle.files[i]];
            newSizes[i] = sizes[bundle.files[i]];
          }
          bundle.files = newFiles;
          if (bundle.fileSizes) bundle.fileSizes = newSizes;
        }
        
        $('#bundles').append(makeBundleDiv(bundle));
    }

    am = new DAM('assets');

    $('#error-status').text('initilizing');
    am.init(function(status) {
        if (status.success == false) {
          $('#error-status').text(status.error);
        } else {
          $('#error-status').text('OK');
          onDAMLoaded();
        }
    });
}

function onDAMLoaded() {
    am.registerEventCallback(null, onBundleEvent);

    for (bundleName in bundles) {
        var added = am.bundleAdded(bundleName);
        var loaded = am.bundleLoaded(bundleName);
        var $status = $('#status-' + bundleName);
        var $action = $('#action-' + bundleName);
        $action.data("loaded", added);
        $action.text(added ? 'purge' : 'load');
        $action.click(function() {
          onAction($(this));
        });

        if (loaded) {
          setStatus(bundleName, 'loaded');
        }
        else if (added) {
          setStatus(bundleName, 'added');
        }
    }
}

function onBundleEvent(message) {
  if (message.event == DAM.GLOBAL_EVENT_BUSY) {
    $('#spinner').css('visibility', 'visible');
  }
  else if (message.event == DAM.GLOBAL_EVENT_NOTBUSY) {
    $('#spinner').css('visibility', 'hidden');
  }
  else if ( message.event == DAM.BUNDLE_EVENT_LOADING
         || message.event == DAM.BUNDLE_EVENT_LOADED
         || message.event == DAM.BUNDLE_EVENT_ERROR ) {         
      setStatus(message.name, message.event);
      $('#error-status').text((typeof(message.error) == 'undefined') ? 'OK' : message.error);
      if (message.event == DAM.BUNDLE_EVENT_LOADED || message.event == DAM.BUNDLE_EVENT_ERROR) {
        setProgress(message.name, 0);
      }
  }
  else if ( message.event == DAM.BUNDLE_EVENT_PROGRESS ) {
    setProgress(message.name, message.done);
  }
}

    
function onAction($element) {
    var bundleName = $element.attr('id').substr(7);
    var $status = $('#status-' + bundleName);
    if ($element.data("loaded") == false) {
        try {
	      am.addBundle(bundles[bundleName]);
          setStatus(bundleName, 'added');
          $element.text('purge');
          $element.data("loaded", true);
	    }
	    catch (e) {
	      $('#error-status').text(e);
	    }
    }
    else {
        am.removeBundle(bundleName);
        setStatus(bundleName, 'notloaded');
        setProgress(bundleName, 0);
        $element.text('load');
        $element.data("loaded", false);
    }
}

function setStatus(bundleName, status) {
  $('#status-' + bundleName).removeClass('notloaded added loading loaded error').addClass(status);
}

function setProgress(bundleName, done) {
    $('#progress-' + bundleName).css('width', Math.ceil(done * 100) + '%');
}


function makeBundleDiv(bundle) {
  var n = bundle.name;
  var status = '<div class="status notloaded" id="status-' + n + '"></div>';
  var name = '<div class="bundlename" id="bundlename-' + n + '">' + n + '</div>';
  var action = '<div class="action" id="action-' + n + '">load</div>';
  var progress = '<div class="progress" id="progress-' + n +  '"></div>';
  var div = '<div class="bundle" id="' + n + '">' + status + name + action + progress + '</div>';
  return div;
}


