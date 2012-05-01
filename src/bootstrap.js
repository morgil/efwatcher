var Ci = Components.interfaces;
Components.utils.import("resource://gre/modules/Services.jsm");
var StyleSheetService = Components.classes["@mozilla.org/content/style-sheet-service;1"].getService(Ci.nsIStyleSheetService);

var console = {
	log: function(msg) {
		try {
			let recentWindow = Services.wm.getMostRecentWindow("navigator:browser");
			recentWindow.Firebug.Console.log(msg);
		} catch(e) {
			Services.console.logStringMessage(msg.toString());
		}
	}
}

const PREF_BRANCH = "extensions.efwatcher.";
//TODO: fragile if button after this one is removed
const PREFS = {
	toolbar:	"nav-bar",
	anchor:	"",
	delay:	120000,
	messageCount: 40,
	unseenOnly: true,
	hostName: "https://www.community.e-fellows.net",
	tooltipMessage: "Linksklick zum Aktualisieren, Mittelklick um alle Benachrichtigungen zu öffnen.\n\nLinksklick auf eine Benachrichtigung um sie zu öffnen, Mittelklick um sie zu löschen.",
	debug: false
};

function debugmsg(msg, handler) {
	let prefs = Services.prefs.getDefaultBranch(PREF_BRANCH);
	if (prefs.getBoolPref("debug")) {
		handler("efwatcher: " + msg);
	}
}

function setDefaultPrefs() {
	let prefs = Services.prefs.getDefaultBranch(PREF_BRANCH);
	for (let [key, val] in Iterator(PREFS)) {
		let setPref = prefs.setCharPref;
		if (typeof(val) == "boolean")
			setPref = prefs.setBoolPref;
		else if (typeof(val) == "number")
			setPref = prefs.setIntPref;
		setPref(key, val);
	}
}

var reloadInterval;
function resetInterval(window) {
	let prefs = Services.prefs.getBranch(PREF_BRANCH);
	
	window.clearInterval(reloadInterval);
	reloadInterval = window.setInterval(updateList, prefs.getIntPref("delay"), window);
}

var BrowserHelper = {
	gotoBoard: function() {
		let prefs = Services.prefs.getBranch(PREF_BRANCH);
		let baseURI = prefs.getCharPref("hostName") + "/start";
		BrowserHelper.openWithReusing(baseURI, function(uri) {
			let isRoot = uri == baseURI;
			return isRoot |= uri == baseURI;
		}, false);
	},
	
	openWithReusing: function(url, comparator, readIds) {
		let prefs = Services.prefs.getBranch(PREF_BRANCH);
		let browserEnumerator = Services.wm.getEnumerator("navigator:browser");
		
		// Check each browser instance for our URL
		let found = false;
		while (!found && browserEnumerator.hasMoreElements()) {
			let browserWin = browserEnumerator.getNext();
			let tabbrowser = browserWin.getBrowser();
			
			// Check each tab of this browser instance
			let numTabs = tabbrowser.browsers.length;
			for (let index = 0; index < numTabs; index++) {
				let currentBrowser = tabbrowser.getBrowserAtIndex(index);
				
				let testURI = currentBrowser.currentURI.spec;
				if (comparator && comparator(testURI) || url == testURI) {
					// The URL is already opened. Select this tab.
					tabbrowser.selectedTab = tabbrowser.mTabs[index];
					
					// Focus *this* browser-window
					browserWin.focus();
					browserWin.loadURI(url);
					
					found = true;
					break;
				}
			}
		}
		
		// Our URL isn't open. Open it now (when option activated)
		if (!found) {
			this.openTab(url);
		}

		if (readIds) {
			BrowserHelper.markRead(readIds);
		}
	},
	
	openTab: function(url) {
		let recentWindow = Services.wm.getMostRecentWindow("navigator:browser");
		if (recentWindow) {
			// Use an existing browser window
			recentWindow.delayedOpenTab(url, null, null, null, null);
		} else {
			// No browser windows are open, so open a new one.
			window.open(url);
		}
	},
	
	markRead: function(readIds)  {
		let prefs = Services.prefs.getBranch(PREF_BRANCH);
		//Angezeigte IDs als gelesen markieren
		let url = prefs.getCharPref("hostName") + "/user/journal/markseen/entries/" + readIds;
		let markReadReq = Components.classes["@mozilla.org/xmlextras/xmlhttprequest;1"].createInstance();
		markReadReq.open("GET", url, true);
		markReadReq.send(null);
	}
}

function updateList(window) {
	resetInterval(window);
	let prefs = Services.prefs.getBranch(PREF_BRANCH);

	let url = prefs.getCharPref("hostName") + "/user/journal/list";
	url = url + "/count/" + prefs.getIntPref("messageCount");
	if (prefs.getBoolPref("unseenOnly")) {
		url = url + "/unseenOnly/1";
	}

	debugmsg("Hole neue Benachrichtigungen von " + url, console.log);

	let req = Components.classes["@mozilla.org/xmlextras/xmlhttprequest;1"].createInstance();
	req.open("GET", url, true);
	req.onreadystatechange = function (aEvt) {
		debugmsg("Requeststatus jetzt " + req.readyState, console.log);
		if (req.readyState != 4) {
			return;
		}
		
		let menu = window.document.getElementById("efwatcher-menu");
		while (menu.childNodes.length > 0)
			menu.removeChild(menu.firstChild);

		let fail = false;
		let doc;

		try {
			doc = JSON.parse(req.responseText);
		} catch (e) {
			debugmsg("Antwort ist kein gültiges JSON", console.warn);
			fail = true;
		}

		if(!doc)
			fail = true;
		else {
			let button = window.document.getElementById("efwatcher-button");
			let newPosts = doc.length;
			button.setAttribute("label", newPosts);
			button.setAttribute("tooltiptext", newPosts + " neue " + (newPosts == 1 ? "Benachrichtigung" : "Benachrichtigungen") + " in der e-fellows Community\n\n" + prefs.getCharPref("tooltipMessage"));
			if (newPosts == "0") {
				debugmsg("Keine neuen Benachrichtungen", console.log);
				fail = true;
			}
			else {
				
				for (let id in doc) {

					let repeatCount = 1;
					let searchedID = -1;
					let links = doc[id].text.match(/\<a href="([^"]*)"\>/g);
					let title = doc[id].id;
					let elementLink = '';
					if (links != null) {
						//Überall wo ich es gesehen habe scheint der letzte vorkommende Link der Relevante zu sein
						elementLink = prefs.getCharPref("hostName") + links[links.length - 1].match(/\<a href="([^"]*)"\>/)[1];

						if (elementLink.indexOf("/cid/") != -1) { //Alle mit cid drin und gleicher aid werden zusammengefasst

							searchedID = elementLink.match(/\/aid\/(\d+)/)[1];
							for each (let child in window.document.getElementById("efwatcher-menu").childNodes){
								if (typeof child != "undefined" && child.getAttribute) {
									let toCompare = child.getAttribute("value").match(/\/aid\/(\d+)/);
									if (toCompare != null && toCompare[1] == searchedID) { //Gleiche aid schon vorhanden:
										repeatCount = parseInt(child.getAttribute("acceltext")) + 1; //aktuellen Zähler um 1 erhöhen
										title = title + "," + child.getAttribute("title");
										menu.removeChild(child); //altes Element löschen
									}
								}
							}
						}
					}

					let newText = doc[id].text.replace(/\<([^\>]*)\>/g, '');

					let item = window.document.createElement("menuitem");
					item.setAttribute("label",     newText)
					item.setAttribute("class",     "menuitem");
					if (repeatCount > 0)
						item.setAttribute("acceltext", "+" + repeatCount);
					item.setAttribute("name",      "bookmark");
					item.setAttribute("title", title);
					item.setAttribute("value",     elementLink);

					if (links != null) {
						item.addEventListener("command", function(evt) {
							BrowserHelper.openWithReusing(elementLink, function (uri) {return (uri.indexOf("/aid/" + searchedID) != -1)}, title);
						}, true);
					} else {
						item.addEventListener("command", function(evt) {
							BrowserHelper.markRead(title);
							item.parentNode.removeChild(item);
							updateList(window);
						});
					}
					item.addEventListener("click", function(evt) {
						if (evt.button == 1) {
								BrowserHelper.markRead(title);
								item.parentNode.removeChild(item);
								updateList(window);
						}
					}, true);
					menu.appendChild(item);
				}
			}
		}
		
		if (fail) {
			let button = window.document.getElementById("efwatcher-button");
			let status = null;
			//Erkennung HTML-Seite mit dem Loginformular, sonst gibt es wohl keine Möglichkeit einen Redirect mit XmlHttpRequest zu erkennen
			if (req.responseText.substr(0,1) == "<") {
				status = "Bitte einloggen";
				button.setAttribute("label", "-");
			} else {
				status = "Keine ungelesenen Benachrichtigungen";
			}
			let loginItem = window.document.createElement("menuitem");
			loginItem.setAttribute("label",    status);
			loginItem.setAttribute("name",     "bookmark");
			//loginItem.setAttribute("disabled", "true");
			loginItem.addEventListener("command", BrowserHelper.gotoBoard, true);
			menu.appendChild(loginItem);
		}
	};
	req.send(null);
}

function loadIntoWindow(window) {
	if (!window) return;
	let prefs = Services.prefs.getBranch(PREF_BRANCH);
	
	// Get the anchor for "overlaying" but make sure the UI is loaded
	let toolbar = window.document.getElementById(prefs.getCharPref("toolbar"));
	if (!toolbar) return;
	
	let anchorId = prefs.getCharPref("anchor");
	let anchor = (anchorId) ? window.document.getElementById(anchorId) : null;
	if (!anchor) anchor = null;
	
	//setup UI
	let button = window.document.createElement("toolbarbutton");
	button.setAttribute("id", "efwatcher-button");
	button.setAttribute("class", "toolbarbutton-1 chromeclass-toolbar-additional");
	button.setAttribute("label", "-");
	button.setAttribute("type", "menu-button");
	button.setAttribute("removable", "true");
	button.setAttribute("tooltiptext", prefs.getCharPref("tooltipMessage"));
	toolbar.insertBefore(button, anchor);
	
	let panel = window.document.createElement("panel");
	panel.setAttribute("type", "arrow");
	button.appendChild(panel);
	
	let menu = window.document.createElement("vbox");
	menu.setAttribute("id", "efwatcher-menu");
	panel.appendChild(menu);
	
	//menu.appendChild(window.document.createElement("menuseparator"));
	
	//let settingsItem = window.document.createElement("menuitem");
	//settingsItem.setAttribute("label", "Einstellungen");
	//menu.appendChild(settingsItem);
	
	//wire up ui
	button.addEventListener("click", function(aEvt) {
		//FIXME: das failt, wenn im popup toolbarbuttons sind
		if ("menu-button" == aEvt.originalTarget.type || aEvt.originalTarget.tagName != "xul:toolbarbutton")
			return;
		switch (aEvt.button) {
		case 1:
			for each (let item in window.document.getElementById("efwatcher-menu").childNodes) {
				//hier loope ich auch über anderes zeug wie z.b. ….childNodes.length
				if (item.getAttribute && item.getAttribute("name") == "bookmark") {
					evt = window.document.createEvent("UIEvents");
					evt.initEvent("command", true, true);
					item.dispatchEvent(evt);
				}
			}
			break;
		case 0:
			updateList(window);
			break;
		case 2:
			//right click, open std menu
			break;
		}
	}, false);
	
	window.addEventListener("aftercustomization", function() {
		prefs.setCharPref("toolbar", button.parentNode.getAttribute("id"));
		let anchor = button.nextSibling;
		prefs.setCharPref("anchor", (anchor) ? anchor.getAttribute("id") : "");
	}, false);
	
	updateList(window);
}

function unloadFromWindow(window) {
	if (!window) return;

	window.clearInterval(reloadInterval);
	
	let button = window.document.getElementById("efwatcher-button");

	if (button)
		button.parentNode.removeChild(button);
}

/*
 bootstrap.js API
*/
function startup(aData, aReason) {
	// Always set the default prefs as they disappear on restart
	setDefaultPrefs();
	
	//register alias for resources
	let resource = Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler);
	let alias = Services.io.newFileURI(aData.installPath);
	if (!aData.installPath.isDirectory())
		alias = Services.io.newURI("jar:" + alias.spec + "!/", null, null);
	resource.setSubstitution("efwatcher", alias);
	
	// Load into any existing windows
	let enumerator = Services.wm.getEnumerator("navigator:browser");
	while (enumerator.hasMoreElements()) {
		let win = enumerator.getNext().QueryInterface(Ci.nsIDOMWindow);
		loadIntoWindow(win);
	}
	
	// Load into any new windows
	Services.wm.addListener({
		onOpenWindow: function(aWindow) {
		// Wait for the window to finish loading
			let domWindow = aWindow.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIDOMWindowInternal);
			domWindow.addEventListener("load", function() {
				domWindow.removeEventListener("load", arguments.callee, false);
				loadIntoWindow(domWindow);
			}, false);
		},
		onCloseWindow: function(aWindow) { },
		onWindowTitleChange: function(aWindow, aTitle) { }
	});
	
	//add stylesheet
	let uri = Services.io.newURI("resource://efwatcher/stylesheet.css", null, null);
	if(!StyleSheetService.sheetRegistered(uri, StyleSheetService.USER_SHEET))
		StyleSheetService.loadAndRegisterSheet(uri, StyleSheetService.USER_SHEET);
}

function shutdown(aData, aReason) {
	// When the application is shutting down we normally don't have to clean up any UI changes
	//but the button position has to be saved
	//if (aReason == APP_SHUTDOWN) return;
	
	//unload resource alias
	let resource = Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler);
	resource.setSubstitution("efwatcher", null);
	
	// Unload from any existing windows
	let enumerator = Services.wm.getEnumerator("navigator:browser");
	while (enumerator.hasMoreElements()) {
		let win = enumerator.getNext().QueryInterface(Ci.nsIDOMWindow);
		unloadFromWindow(win);
	}
	
	//remove stylesheet
	let uri = Services.io.newURI("resource://efwatcher/stylesheet.css", null, null);
	if(StyleSheetService.sheetRegistered(uri, StyleSheetService.USER_SHEET))
		StyleSheetService.unregisterSheet(uri, StyleSheetService.USER_SHEET);
}

function install(aData, aReason) { }

function uninstall(aData, aReason) { }
