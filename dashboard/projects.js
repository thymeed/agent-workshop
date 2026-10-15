/**
 * Live project picker: fetch the bridge's project list, render it, switch the bridge's
 * transcript scope, and hand the new scope to Insights + History. Exposed as
 * window.WorkshopProjects. The selected project id/label stay owned by app.js and are
 * reached through getters/setters, so the rest of the dashboard is unaffected.
 */
(function () {
  "use strict";

  var d = null;
  var selecting = false;

  function init(deps) {
    d = deps || {};
  }

  function updateFooterProject() {
    if (!d.footerProject) return;
    if (d.getMode() === "live" && d.getProjectLabel()) {
      d.footerProject.textContent = d.getProjectLabel();
    } else {
      d.footerProject.textContent = "cursor --model opus --advisor fable";
    }
  }

  function setProjectPickerVisible(visible) {
    if (!d.projectPicker) return;
    d.projectPicker.hidden = !visible;
  }

  function fillProjectPicker(data) {
    if (!d.projectPicker || !data) return;
    var projects = data.projects || [];
    var selected = data.selectedId || d.getProjectId();
    if (data.selectedId) d.setProject(data.selectedId, data.selectedLabel);

    d.projectPicker.innerHTML = "";
    if (!projects.length) {
      var opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No Cursor projects found";
      d.projectPicker.appendChild(opt);
      d.projectPicker.disabled = true;
      updateFooterProject();
      if (
        d.getMode() === "live" &&
        d.isBridgeConnected() &&
        d.getLivePresence() !== "bridge-down" &&
        d.getLivePresence() !== "file-origin"
      ) {
        d.setLivePresence("no-projects");
      }
      return;
    }

    d.projectPicker.disabled = false;
    if (d.getMode() === "live" && d.getLivePresence() === "no-projects") {
      d.setLivePresence(
        Date.now() - d.getLastLiveEventAt() < d.quietAfterMs && d.getLastLiveEventAt() > 0
          ? "streaming"
          : "quiet-healthy"
      );
    }
    projects.forEach(function (p) {
      var option = document.createElement("option");
      option.value = p.id;
      option.textContent = p.label || p.id;
      if (p.id === selected) option.selected = true;
      d.projectPicker.appendChild(option);
    });
    if (selected && d.projectPicker.value !== selected) {
      d.projectPicker.value = selected;
    }
    updateFooterProject();
  }

  function loadProjects() {
    if (!d.projectPicker) return Promise.resolve(null);
    return fetch(d.bridgeUrl + "/api/projects", { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("projects " + r.status);
        return r.json();
      })
      .then(function (data) {
        if (d.getMode() === "live") setProjectPickerVisible(true);
        fillProjectPicker(data);
        return data;
      })
      .catch(function () {
        setProjectPickerVisible(false);
        return null;
      });
  }

  function focusLatestSession(meta) {
    var panel = d.getInsightsPanel();
    if (!panel || typeof panel.focusLatestSession !== "function") return;
    var hint = meta && meta.latestSessionId ? meta.latestSessionId : "";
    panel.focusLatestSession(hint).then(function () {
      d.remountHistoryReplayIfNeeded();
    });
  }

  function onScopeChange(meta, opts) {
    opts = opts || {};
    focusLatestSession(meta);
    if (opts.navigateHistory) d.setViewMode("history");
  }

  function selectProject(id) {
    if (!id || selecting) return Promise.resolve(null);
    selecting = true;
    return fetch(d.bridgeUrl + "/api/select", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json", "X-Cursor-Bridge": "1" },
      body: JSON.stringify({ id: id })
    })
      .then(function (r) {
        return r
          .json()
          .catch(function () {
            return {};
          })
          .then(function (body) {
            if (!r.ok) {
              return {
                ok: false,
                error: (body && body.error) || "Select failed (" + r.status + ")"
              };
            }
            return body;
          });
      })
      .then(function (data) {
        if (data && data.ok) {
          d.setProject(data.projectId, data.projectLabel);
          updateFooterProject();
        }
        return data;
      })
      .catch(function () {
        return { ok: false, error: "Could not switch project" };
      })
      .then(function (data) {
        selecting = false;
        return data;
      });
  }

  window.WorkshopProjects = {
    init: init,
    loadProjects: loadProjects,
    fillProjectPicker: fillProjectPicker,
    setProjectPickerVisible: setProjectPickerVisible,
    updateFooterProject: updateFooterProject,
    selectProject: selectProject,
    focusLatestSession: focusLatestSession,
    onScopeChange: onScopeChange
  };
})();
