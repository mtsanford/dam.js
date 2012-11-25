dam.js - Downloadable Asset Manager
===================================

Description
-----------
dam.js is a javascript library that manages the download of bundles of files for phonegap/cordova apps.

A bundle description object is passed into DAM.addBundle(), and the download starts.  If download fails due to network errors, it will be retried later.  Downloaded files are persistent across launches of the app, and can be referred to by a local URL.

Notification callbacks can be registered (see section on events).   Callbacks are guaranteed to be called asynchronously with calls to DAM. 

This library requires Phonegap/Cordova 2.2.   The supported platforms should be:

Android [TESTED]
iOS
BlackBerry WebWorks (OS 5.0 and higher)
Windows Phone 7

Usage example
--------------
```javascript
var bundle = {
  name : "bundle1",
  files : [ "http://example.com/image1.jpg", "http://example.com/image1.jpg"]
};

document.addEventListener("deviceready", onDeviceReady, false);

function onDeviceReady() {
  dam = new DAM('asset_folder'); /* global */ 
  dam.init(function(status) {
    if (status.success == true) {
      dam.registerEventCallback(null, damEvent);
      dam.addBundle(bundle);
    }
  });
}

function damEvent(e) {
  if (e.event == DAM.BUNDLE_EVENT_LOADED) {
    console.log("bundle loaded!");
    console.log("local URL of " + bundle.files[0] + " is " + dam.localURL(bundle.files[0]));
  }
}

```

Public API
----------
 DAM(baseDir) create DAM object with a given base directory
 DAM.init(callback) Initialize a DAM
 DAM.registerEventCallback(context, callback)
 DAM.addBundle(bundle)
 DAM.removeBundle(bundleName)
 DAM.getBundleNames() returns array of bundle names
 DAM.getBundle(bundleName) returns a bundle record
 DAM.bundleLoaded(bundleName) is this bundle loaded?
 DAM.bundleAdded(bundleName) is this bundle in this.bundles?
 DAM.localURL(remoteFile) get local URL of a file
 
Bundle format
-------------
Here is an example bundle object to be passed into DAM.addBundle():
```javascript
{ 
  name : "bundle1",
  files : [ "http://example.com/image1.jpg", "http://example.com/image1.jpg"],
  fileSizes : [ 150543, 459044 ]
}
```
filesSizes is optional, and serves only to give more accurate progress events.

Events
------
Bundle Events:
 
  {event: DAM.BUNDLE_EVENT_LOADING, name:'bundleName'} when bundle starts loading
  {event: DAM.BUNDLE_EVENT_PROGRESS, name:'bundleName', done:0.5} when bundle load progress happens
  {event: DAM.BUNDLE_EVENT_LOADED, name:'bundleName'} when bundle finishes loading
  {event: DAM.BUNDLE_EVENT_ERROR, name:'bundleName', error:'what happened'} when bundle cannot be loaded

Global events: 

  {event: DAM.GLOBAL_EVENT_BUSY} a download or remove task is in progress
  {event: DAM.GLOBAL_EVENT_NOTBUSY} no task in progress

Sample application
------------------
To run the sample application, follow the instructions to create a phonegap/cordova shell application on the platform of your choice, then the copy the contents of this git respository into the HTML assets folder for the app.  Ensure that the app is granted permission to access the internet, and write files.

To Do
-----
Support for browsers that support the HTML5 FileWriter and XHR2 & APIs (e.g. Chrome)
Support for bundle size queries.
Provide easy way to ensure files are downloaded to a folder that will be automatically removed on app uninstall.

 
