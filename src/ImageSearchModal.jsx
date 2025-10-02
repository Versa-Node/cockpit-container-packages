import React, { useState, useRef } from 'react';
import { Button } from "@patternfly/react-core/dist/esm/components/Button";
import { DataList, DataListCell, DataListItem, DataListItemCells, DataListItemRow } from "@patternfly/react-core/dist/esm/components/DataList";
import { Flex } from "@patternfly/react-core/dist/esm/layouts/Flex";
import { Form, FormGroup } from "@patternfly/react-core/dist/esm/components/Form";
import { FormSelect, FormSelectOption } from "@patternfly/react-core/dist/esm/components/FormSelect";
import { Modal } from "@patternfly/react-core/dist/esm/components/Modal";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput";
import { ExclamationCircleIcon } from '@patternfly/react-icons';

import { EmptyStatePanel } from "cockpit-components-empty-state.jsx";
import { ErrorNotification } from './Notification.jsx';
import cockpit from 'cockpit';
import rest from './rest.js';
import * as client from './client.js';
import { fallbackRegistries, useDockerInfo } from './util.js';
import { useDialogs } from "dialogs.jsx";

import './ImageSearchModal.css';

const _ = cockpit.gettext;

// ---------- GHCR helpers ----------
const GHCR_NAMESPACE = "ghcr.io/versanode/";

const isGhcr = (reg) => (reg || "").trim().toLowerCase() === "ghcr.io";

// user typed a GHCR versanode reference? (either fully-qualified or org-prefixed)
const isGhcrVersanodeTerm = (term) =>
  /^ghcr\.io\/versanode\/[^/]+/i.test(term || "") || /^versanode\/[^/]+/i.test(term || "");

// turn free text into the final ghcr.io/versanode/<name>
const buildGhcrVersanodeName = (txt) => {
  const t = (txt || "").trim()
    .replace(/^ghcr\.io\/?/i, "")
    .replace(/^versanode\/?/i, "");
  return (GHCR_NAMESPACE + t).replace(/\/+$/, "");
};

// ---------- DEV ONLY: hard-coded PAT listing for GHCR org ----------
// Do NOT ship this. Move to a server-side proxy or cockpit.spawn with a root-owned file.
const GH_ORG = "Versa-Node";
const GH_TOKEN = "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";
async function fetchGhcrOrgPackagesDev() {
  const resp = await fetch(
    `https://api.github.com/orgs/${GH_ORG}/packages?package_type=container&per_page=100`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${GH_TOKEN}`,
      },
    }
  );
  if (!resp.ok) throw new Error(`GitHub API ${resp.status}: ${await resp.text()}`);
  const packages = await resp.json();
  // Map to your DataList item shape (lowercase keys)
  return (packages || []).map(p => ({
    name: `ghcr.io/versanode/${p.name}`,
    description: p.description || "GitHub Container Registry (versanode)",
  }));
}

export const ImageSearchModal = ({ downloadImage }) => {
  const [searchInProgress, setSearchInProgress] = useState(false);
  const [searchFinished, setSearchFinished] = useState(false);
  const [imageIdentifier, setImageIdentifier] = useState('');
  const [imageList, setImageList] = useState([]);
  const [imageTag, setImageTag] = useState("");
  const [selectedRegistry, setSelectedRegistry] = useState("ghcr.io");
  const [selected, setSelected] = useState("");
  const [dialogError, setDialogError] = useState("");
  const [dialogErrorDetail, setDialogErrorDetail] = useState("");
  const [typingTimeout, setTypingTimeout] = useState(null);

  const activeConnectionRef = useRef(null);

  const { registries } = useDockerInfo();
  const Dialogs = useDialogs();

  // Registries to use for searching (ensure fallbackRegistries in util.js includes ["docker.io","ghcr.io"])
  const searchRegistries =
    registries?.search && registries.search.length !== 0 ? registries.search : fallbackRegistries;

  const closeActiveConnection = () => {
    if (activeConnectionRef.current) {
      try { activeConnectionRef.current.close(); } catch (e) {}
      activeConnectionRef.current = null;
    }
  };

  // Don't use selectedRegistry state inside due to async updates; pass it in as arg.
  const onSearchTriggered = async (searchRegistry = "", forceSearch = false) => {
    setSearchFinished(false);

    // Short-circuit length unless Enter is pressed
    if (imageIdentifier.length < 2 && !forceSearch)
      return;

    const targetGhcr = isGhcr(searchRegistry) || isGhcrVersanodeTerm(imageIdentifier);

    // If GHCR is targeted and no specific repo typed yet, list org packages via GitHub API (DEV ONLY)
    const typedRepo = imageIdentifier
      .replace(/^ghcr\.io\/?versanode\/?/i, "")
      .replace(/^versanode\/?/i, "")
      .trim();

    if (targetGhcr && typedRepo.length === 0) {
      setDialogError(""); setDialogErrorDetail("");
      setSearchInProgress(true);
      try {
        const pkgs = await fetchGhcrOrgPackagesDev();
        setImageList(pkgs);
        setSelected(pkgs.length ? "0" : "");
      } catch (e) {
        setImageList([]);
        setSelected("");
        setDialogError(_("Failed to list GHCR packages"));
        setDialogErrorDetail(e?.message || String(e));
      } finally {
        setSearchInProgress(false);
        setSearchFinished(true);
      }
      closeActiveConnection();
      return;
    }

    if (targetGhcr) {
      // No /images/search on GHCR; synthesize a single result under versanode
      const fullName = buildGhcrVersanodeName(imageIdentifier);
      const bareNamespace = GHCR_NAMESPACE.replace(/\/+$/, "");
      if (!fullName || fullName === bareNamespace) {
        setImageList([]);
        setSelected("");
      } else {
        setImageList([{ name: fullName, description: _("GitHub Container Registry (versanode)") }]);
        setSelected("0");
      }
      setSearchInProgress(false);
      setSearchFinished(true);
      closeActiveConnection();
      return;
    }

    // Docker Hub (or other registries that support the search API)
    setSearchInProgress(true);

    // Close any previous connection, then open a fresh one
    closeActiveConnection();
    activeConnectionRef.current = rest.connect(client.getAddress());

    let queryRegistries = searchRegistries;
    if (searchRegistry !== "") {
      queryRegistries = [searchRegistry];
    }

    // if a user searches for `docker.io/cockpit` let docker search in the user specified registry.
    if (imageIdentifier.includes('/')) {
      queryRegistries = [""];
    }

    const searches = queryRegistries.map(rr => {
      const registry = rr.length < 1 || rr[rr.length - 1] === "/" ? rr : rr + "/";
      return activeConnectionRef.current.call({
        method: "GET",
        path: client.VERSION + "/images/search",
        body: "",
        params: {
          term: registry + imageIdentifier
        }
      });
    });

    Promise.allSettled(searches)
      .then(reply => {
        if (reply) {
          let results = [];

          for (const result of reply) {
            if (result.status === "fulfilled") {
              results = results.concat(JSON.parse(result.value));
            } else {
              setDialogError(_("Failed to search for new images"));
              setDialogErrorDetail(result.reason
                ? cockpit.format(_("Failed to search for images: $0"), result.reason.message)
                : _("Failed to search for images."));
            }
          }

          setImageList(results || []);
          setSearchInProgress(false);
          setSearchFinished(true);
        }
      })
      .catch(err => {
        setDialogError(_("Failed to search for new images"));
        setDialogErrorDetail(err?.message || String(err));
        setSearchInProgress(false);
        setSearchFinished(true);
      });
  };

  const onKeyDown = (e) => {
    if (e.key !== ' ') { // Space should not trigger search
      const forceSearch = e.key === 'Enter';
      if (forceSearch) e.preventDefault();

      // Reset the timer, to make the http call after 250ms
      clearTimeout(typingTimeout);
      setTypingTimeout(setTimeout(() => onSearchTriggered(selectedRegistry, forceSearch), 250));
    }
  };

  const onDownloadClicked = () => {
    if (!imageList.length || selected === "") return;
    const selectedImageName = imageList[selected].name;
    closeActiveConnection();
    Dialogs.close();
    // default tag to "latest" if empty/whitespace
    const tag = (imageTag || "").trim() || "latest";
    downloadImage(selectedImageName, tag);
  };

  const handleClose = () => {
    closeActiveConnection();
    Dialogs.close();
  };

  return (
    <Modal
      isOpen
      className="docker-search"
      position="top"
      variant="large"
      onClose={handleClose}
      title={_("Search for an image")}
      footer={
        <>
          <Form isHorizontal className="image-search-tag-form">
            <FormGroup fieldId="image-search-tag" label={_("Tag")}>
              <TextInput
                className="image-tag-entry"
                id="image-search-tag"
                type="text"
                placeholder="latest"
                value={imageTag}
                onChange={(_event, value) => setImageTag(value)}
              />
            </FormGroup>
          </Form>
          <Button variant="primary" isDisabled={selected === ""} onClick={onDownloadClicked}>
            {_("Download")}
          </Button>
          <Button variant="link" className="btn-cancel" onClick={handleClose}>
            {_("Cancel")}
          </Button>
        </>
      }
    >
      <Form isHorizontal>
        {dialogError && <ErrorNotification errorMessage={dialogError} errorDetail={dialogErrorDetail} />}
        <Flex spaceItems={{ default: 'inlineFlex', modifier: 'spaceItemsXl' }}>
          <FormGroup fieldId="search-image-dialog-name" label={_("Search for")}>
            <TextInput
              id="search-image-dialog-name"
              type="text"
              placeholder={_("Type image (e.g. nginx) or versanode/<repo>")}
              value={imageIdentifier}
              onKeyDown={onKeyDown}
              onChange={(_event, value) => setImageIdentifier(value)}
            />
          </FormGroup>
          <FormGroup fieldId="registry-select" label={_("in")}>
            <FormSelect
              id="registry-select"
              value={selectedRegistry}
              onChange={(_ev, value) => {
                setSelectedRegistry(value);
                clearTimeout(typingTimeout);
                onSearchTriggered(value, false);
              }}
            >
              {(searchRegistries || []).map(r => (
                <FormSelectOption
                  value={r}
                  key={r}
                  label={r === "ghcr.io" ? "ghcr.io (versanode)" : r}
                />
              ))}
            </FormSelect>
          </FormGroup>
        </Flex>
      </Form>

      {searchInProgress && <EmptyStatePanel loading title={_("Searching...")} />}

      {((!searchInProgress && !searchFinished) || imageIdentifier === "") && (
        <EmptyStatePanel title={_("No images found")} paragraph={_("Start typing to look for images.")} />
      )}

      {searchFinished && imageIdentifier !== '' && (
        <>
          {imageList.length === 0 && (
            <EmptyStatePanel
              icon={ExclamationCircleIcon}
              title={cockpit.format(_("No results for $0"), imageIdentifier)}
              paragraph={_("Retry another term.")}
            />
          )}
          {imageList.length > 0 && (
            <DataList
              isCompact
              selectedDataListItemId={"image-list-item-" + selected}
              onSelectDataListItem={(_, key) => setSelected(key.split('-').slice(-1)[0])}
            >
              {imageList.map((image, iter) => (
                <DataListItem id={"image-list-item-" + iter} key={iter}>
                  <DataListItemRow>
                    <DataListItemCells
                      dataListCells={[
                        <DataListCell key="primary content">
                          <span className="image-name">{image.name}</span>
                        </DataListCell>,
                        <DataListCell key="secondary content" wrapModifier="truncate">
                          <span className="image-description">{image.description}</span>
                        </DataListCell>
                      ]}
                    />
                  </DataListItemRow>
                </DataListItem>
              ))}
            </DataList>
          )}
        </>
      )}
    </Modal>
  );
};
