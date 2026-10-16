/**
 * Settings → Fromcubes: choose the identity provider and the CSS engine.
 *
 * Exactly one provider per kind, shown as a radio list, so two can never be
 * active at once. Reads and writes `/fromcubes-react/providers`; the server
 * validates, persists to <userDir>/fromcubes/providers.json, and applies the
 * change (identity: every portal session reloads; css: every portal rebuilds).
 * A kind set in settings.js is shown locked.
 *
 * Node-RED shows a pane by the element id `red-ui-settings-tab-<pane id>`,
 * and calls get() every time the Settings tray opens — so each call builds
 * a fresh element and loads fresh data.
 */
(function () {
  "use strict";

  var PANE_ID = "fromcubes";
  var URL = "fromcubes-react/providers";

  var KINDS = [
    {
      kind: "identity",
      title: "Identity provider",
      hint: "Who is behind a portal session — used by Portal Auth, auth-cast and per-user delivery.",
      setting: "identityProvider",
    },
    {
      kind: "css",
      title: "CSS engine",
      hint: "Generates each portal's stylesheet at deploy. Changing it rebuilds every portal.",
      setting: "cssEngine",
    },
  ];

  function errorText(xhr) {
    var body = xhr && xhr.responseJSON;
    return (body && body.error) || (xhr && xhr.statusText) || "request failed";
  }

  function renderKind(container, def, info, onPick) {
    var section = $('<div class="fc-ps-section"></div>').appendTo(container);
    $("<h3></h3>").text(def.title).appendTo(section);
    $('<p class="fc-ps-hint"></p>').text(def.hint).appendTo(section);

    if (info.locked) {
      $('<p class="fc-ps-note"></p>')
        .append($("<i></i>").addClass("fa fa-lock"))
        .append(
          document.createTextNode(
            " Set in settings.js (portalReact." + def.setting + ") — change it there.",
          ),
        )
        .appendTo(section);
    }
    if (info.missing) {
      $('<p class="fc-ps-warn"></p>')
        .append($("<i></i>").addClass("fa fa-warning"))
        .append(
          document.createTextNode(
            ' "' + info.selected + '" is selected but not installed' +
              (def.kind === "identity"
                ? " — every session is anonymous."
                : " — portals are served without CSS."),
          ),
        )
        .appendTo(section);
    }

    var name = "fc-ps-" + def.kind;
    info.options.forEach(function (opt) {
      var inputId = name + "-" + opt.id.replace(/[^A-Za-z0-9_-]/g, "_");
      var row = $('<div class="red-ui-settings-row fc-ps-row"></div>').appendTo(section);
      var input = $('<input type="radio">')
        .attr({ id: inputId, name: name, value: opt.id })
        .prop("checked", opt.id === info.selected)
        .prop("disabled", info.locked || opt.missing || !!opt.problem)
        .appendTo(row);
      var label = $("<label></label>").attr("for", inputId).appendTo(row);
      $('<span class="fc-ps-id"></span>').text(opt.id).appendTo(label);
      $('<span class="fc-ps-module"></span>')
        .text(opt.missing ? "not installed" : opt.module)
        .appendTo(label);
      if (opt.label) $('<span class="fc-ps-label"></span>').text(opt.label).appendTo(label);
      if (opt.problem) $('<span class="fc-ps-problem"></span>').text(opt.problem).appendTo(label);
      input.on("change", function () {
        if (this.checked) onPick(def, opt.id, info.selected);
      });
    });
  }

  function createPane() {
    var pane = $('<div class="red-ui-help fc-ps"></div>').attr(
      "id",
      "red-ui-settings-tab-" + PANE_ID,
    );
    var body = $('<div class="fc-ps-body"></div>').appendTo(pane);

    function render(data) {
      body.empty();
      KINDS.forEach(function (def) {
        if (data[def.kind]) renderKind(body, def, data[def.kind], pick);
      });
    }

    function load() {
      body.empty().append($('<p class="fc-ps-hint"></p>').text("Loading…"));
      $.ajax({ url: URL, method: "GET", dataType: "json" })
        .done(render)
        .fail(function (xhr) {
          body.empty();
          $('<p class="fc-ps-warn"></p>')
            .text("Cannot load providers: " + errorText(xhr))
            .appendTo(body);
        });
    }

    function save(def, id) {
      $.ajax({
        url: URL,
        method: "PUT",
        contentType: "application/json",
        dataType: "json",
        data: JSON.stringify({ kind: def.kind, id: id }),
      })
        .done(function (data) {
          RED.notify(def.title + ": " + id, "success");
          render(data);
          // className completion follows the engine (portal-react.html).
          if (def.kind === "css" && window.__fcRefreshCssClasses) {
            window.__fcRefreshCssClasses();
          }
        })
        .fail(function (xhr) {
          RED.notify(def.title + " not changed: " + errorText(xhr), "error");
          load();
        });
    }

    // Identity decides who counts as logged in on every portal, and every
    // open portal tab reloads when it changes — so it asks first. CSS only
    // restyles, and applies straight away.
    function pick(def, id, previous) {
      if (def.kind !== "identity") {
        save(def, id);
        return;
      }
      var note = RED.notify(
        "<p>Switch the identity provider from <b>" +
          RED.utils.sanitize(previous) +
          "</b> to <b>" +
          RED.utils.sanitize(id) +
          "</b>?</p><p>This changes who counts as logged in on every portal. " +
          "Every open portal tab reloads.</p>",
        {
          modal: true,
          fixed: true,
          type: "warning",
          buttons: [
            {
              text: RED._("common.label.cancel"),
              click: function () {
                note.close();
                load(); // put the radio back on the provider still in force
              },
            },
            {
              text: "Switch",
              class: "primary",
              click: function () {
                note.close();
                save(def, id);
              },
            },
          ],
        },
      );
    }

    load();
    return pane;
  }

  function init() {
    if (!window.RED || !RED.userSettings || typeof RED.userSettings.add !== "function") {
      return;
    }
    RED.userSettings.add({ id: PANE_ID, title: "Fromcubes", get: createPane });
  }

  if (window.RED && RED.userSettings) init();
  else $(init);
})();
