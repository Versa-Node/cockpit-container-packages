import React from 'react';
import PropTypes from 'prop-types';
import { Button } from "@patternfly/react-core/dist/esm/components/Button";
import { EmptyState, EmptyStateBody } from "@patternfly/react-core/dist/esm/components/EmptyState";
import { FormFieldGroup, FormFieldGroupHeader } from "@patternfly/react-core/dist/esm/components/Form";
import { HelperText, HelperTextItem } from "@patternfly/react-core/dist/esm/components/HelperText";

import './cockpit-components-dynamic-list.scss';

/* ============================== DEBUG ============================== */
const DEBUG_DYNAMIC_LIST = true; // set false to silence
const DLOG = (...a) => DEBUG_DYNAMIC_LIST && console.log("[DynamicListForm]", ...a);
const DWARN = (...a) => DEBUG_DYNAMIC_LIST && console.warn("[DynamicListForm]", ...a);
/* ================================================================== */

/* Utility: shallow-compare arrays of rows, ignoring the auto 'key' field */
function stripKeys(list = []) {
  return (list || []).map(r => {
    if (!r) return r;
    const { key, ...rest } = r;
    return rest;
  });
}
function rowsEqualNoKey(a = [], b = []) {
  try {
    return JSON.stringify(stripKeys(a)) === JSON.stringify(stripKeys(b));
  } catch {
    return false;
  }
}

/* Dynamic list with a variable number of rows. Each row is a custom component.
 *
 * Props:
 *   - id, label, actionLabel, emptyStateString, formclass
 *   - itemcomponent (React element type), options (optional)
 *   - onChange(list)  // receives the internal list (with keys)
 *   - validationFailed, onValidationChange
 *   - default         // shape for new rows (merged with row data)
 *   - value           // OPTIONAL controlled initial/next rows [{...},{...}]
 */
export class DynamicListForm extends React.Component {
  constructor(props) {
    super(props);
    this.state = { list: [] };
    this.keyCounter = 0;

    this.removeItem = this.removeItem.bind(this);
    this.addItem = this.addItem.bind(this);
    this.onItemChange = this.onItemChange.bind(this);

    // public helpers for parent debugging / seeding
    this.seed = this.seed.bind(this);
    this.getList = this.getList.bind(this);
  }

  /* Attach auto-increment keys and merge defaults without mutating input */
  _withKeysFrom = (value = []) => {
    const out = (value || []).map((row) => ({
      key: this.keyCounter++,
      ...(this.props.default || {}),
      ...(row || {}),
    }));
    return out;
  };

  componentDidMount() {
    if (Array.isArray(this.props.value)) {
      const next = this._withKeysFrom(this.props.value);
      DLOG("mount: adopting props.value ->", next);
      this.setState({ list: next }, () => this.props.onChange?.(this.state.list));
    } else {
      DLOG("mount: no props.value, starting empty");
    }
  }

  componentDidUpdate(prevProps, prevState) {
    // Controlled sync: if props.value changed (by ref OR equal length but different content),
    // adopt it into our state.list (with fresh keys).
    if (this.props.value !== prevProps.value) {
      const next = this._withKeysFrom(this.props.value || []);
      if (!rowsEqualNoKey(next, this.state.list)) {
        DLOG("props.value changed -> syncing into state", { prevLen: prevState.list.length, nextLen: next.length });
        this.setState({ list: next }, () => this.props.onChange?.(this.state.list));
      } else {
        DLOG("props.value changed (ref) but rows identical; skipping state update");
      }
    }

    // Log structural changes for visibility
    if (!rowsEqualNoKey(prevState.list, this.state.list)) {
      DLOG("state.list changed",
        { prevLen: prevState.list?.length || 0, nextLen: this.state.list?.length || 0 },
        { prev: stripKeys(prevState.list), next: stripKeys(this.state.list) }
      );
    }
  }

  /* Public: force-load rows (used by parent hacks/tests) */
  seed(rows = []) {
    const next = this._withKeysFrom(rows);
    DLOG("seed() called with", rows, " -> adopting as ", next);
    this.setState({ list: next }, () => this.props.onChange?.(this.state.list));
  }

  /* Public: quick accessor for parent console checks */
  getList() {
    return this.state.list;
  }

  removeItem(idx) {
    const validationFailedDelta = this.props.validationFailed ? [...this.props.validationFailed] : [];
    delete validationFailedDelta[idx];
    this.props.onValidationChange?.(validationFailedDelta);

    this.setState(state => {
      const items = [...state.list];
      DLOG("removeItem", { idx, beforeLen: items.length, removing: items[idx] });
      delete items[idx]; // keep holes to preserve mapping
      return { list: items };
    }, () => this.props.onChange?.(this.state.list));
  }

  addItem() {
    this.setState(state => {
      const newRow = { key: this.keyCounter++, ...(this.props.default || {}) };
      DLOG("addItem", newRow);
      return { list: [...state.list, newRow] };
    }, () => this.props.onChange?.(this.state.list));
  }

  onItemChange(idx, field, value) {
    this.setState(state => {
      const items = [...state.list];
      if (!items[idx]) {
        DWARN("onItemChange on empty slot", { idx, field, value });
        items[idx] = { key: this.keyCounter++, ...(this.props.default || {}) };
      }
      items[idx][field] = value || null;
      DLOG("onItemChange", { idx, field, value, row: items[idx] });
      return { list: items };
    }, () => this.props.onChange?.(this.state.list));
  }

  render () {
    const { id, label, actionLabel, formclass, emptyStateString, helperText, validationFailed, onValidationChange } = this.props;
    const dialogValues = this.state;

    return (
      <FormFieldGroup
        header={
          <FormFieldGroupHeader
            titleText={{ text: label }}
            actions={<Button variant="secondary" className="btn-add" onClick={this.addItem}>{actionLabel}</Button>}
          />
        }
        className={"dynamic-form-group " + (formclass || "")}
      >
        {
          dialogValues.list.some(item => item !== undefined)
            ? <>
                {dialogValues.list.map((item, idx) => {
                  if (item === undefined) return null;

                  return React.createElement(this.props.itemcomponent, {
                    idx,
                    item,
                    id: id + "-" + idx,
                    key: item.key ?? idx,          // prefer stable key
                    onChange: this.onItemChange,
                    removeitem: this.removeItem,
                    additem: this.addItem,
                    options: this.props.options,
                    validationFailed: validationFailed && validationFailed[idx],
                    onValidationChange: value => {
                      const delta = validationFailed ? [...validationFailed] : [];
                      delta[idx] = value;
                      if (Object.keys(delta[idx] || {}).length === 0) delete delta[idx];
                      onValidationChange?.(delta);
                    },
                  });
                })}
                {helperText &&
                  <HelperText>
                    <HelperTextItem>{helperText}</HelperTextItem>
                  </HelperText>
                }
              </>
            : <EmptyState>
                <EmptyStateBody>{emptyStateString}</EmptyStateBody>
              </EmptyState>
        }
      </FormFieldGroup>
    );
  }
}

DynamicListForm.propTypes = {
  emptyStateString: PropTypes.string.isRequired,
  onChange: PropTypes.func.isRequired,
  id: PropTypes.string.isRequired,
  itemcomponent: PropTypes.elementType.isRequired,
  formclass: PropTypes.string,
  options: PropTypes.object,
  validationFailed: PropTypes.array,
  onValidationChange: PropTypes.func,
  default: PropTypes.object,
  value: PropTypes.array,     // <-- new: controlled list support
};
