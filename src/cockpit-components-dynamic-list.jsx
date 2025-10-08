// cockpit-components-dynamic-list.jsx
import React from 'react';
import PropTypes from 'prop-types';
import { Button } from "@patternfly/react-core/dist/esm/components/Button";
import { EmptyState, EmptyStateBody } from "@patternfly/react-core/dist/esm/components/EmptyState";
import { FormFieldGroup, FormFieldGroupHeader } from "@patternfly/react-core/dist/esm/components/Form";
import { HelperText, HelperTextItem } from "@patternfly/react-core/dist/esm/components/HelperText";

import './cockpit-components-dynamic-list.scss';

function dbg(id) { return `[DynamicListForm:${id}]`; }
function summarize(list, max = 5) {
  if (!Array.isArray(list)) return list;
  const out = [];
  for (let i = 0; i < Math.min(list.length, max); i++) {
    const it = list[i];
    out.push(it === undefined ? { idx: i, deleted: true } : { idx: i, key: it?.key, ...it });
  }
  if (list.length > max) out.push({ more: list.length - max });
  return out;
}

// Normalize an array of rows for comparison: drop `key`, keep holes
function normalizeForCompare(value) {
  if (!Array.isArray(value)) return '[]';
  const norm = value.map(v => {
    if (v === undefined) return '__hole__';
    const { key, ...rest } = (v || {});
    return rest;
  });
  try { return JSON.stringify(norm); } catch { return String(norm); }
}

// Normalize itemcomponent to a valid type for React.createElement
function resolveItemType(ic) {
  if (React.isValidElement(ic)) return ic.type;
  if (typeof ic === 'function' || (ic && typeof ic === 'object' && ic.$$typeof)) return ic;
  return null;
}

export class DynamicListForm extends React.Component {
  constructor(props) {
    super(props);

    const { list, nextKey } = this._hydrateFromValue(props.value, 0, props.id);
    this.state = { list, keyCounter: nextKey };

    this._lastNormValue = normalizeForCompare(props.value);

    this.removeItem = this.removeItem.bind(this);
    this.addItem = this.addItem.bind(this);
    this.onItemChange = this.onItemChange.bind(this);

    console.groupCollapsed(`${dbg(props.id)} ctor`);
    console.log('props.value len:', Array.isArray(props.value) ? props.value.length : '(not array)');
    console.log('props.value sample:', summarize(props.value));
    console.log('state.list len:', list.filter(Boolean).length);
    console.groupEnd();
  }

  _hydrateFromValue(value, startKey, idForLog) {
    const out = [];
    let k = startKey;
    if (Array.isArray(value) && value.length > 0) {
      value.forEach((row, idx) => {
        if (row === undefined || row === null) { out[idx] = undefined; return; }
        const withKey = { ...(row || {}) };
        if (withKey.key === undefined) withKey.key = k++;
        out[idx] = withKey;
      });
    }
    console.log(`${dbg(idForLog)} hydrateFromValue -> rows: ${out.filter(Boolean).length}`, summarize(out));
    return { list: out, nextKey: k };
  }

  componentDidMount() {
    console.log(`${dbg(this.props.id)} mounted list len:`, this.state.list.filter(Boolean).length);
    // No onChange here — parent is the source of truth for `value`
  }

  componentDidUpdate(prevProps) {
    // Only sync when the *normalized* content of value actually changes
    const nextNorm = normalizeForCompare(this.props.value);
    if (nextNorm !== this._lastNormValue) {
      console.groupCollapsed(`${dbg(this.props.id)} props.value changed`);
      console.log('prev norm:', this._lastNormValue);
      console.log('next norm:', nextNorm);
      const { list, nextKey } = this._hydrateFromValue(this.props.value, this.state.keyCounter, this.props.id);
      this._lastNormValue = nextNorm; // update snapshot BEFORE setState callback to avoid loops
      this.setState({ list, keyCounter: nextKey }, () => {
        console.log('synced state.list len:', this.state.list.filter(Boolean).length, summarize(this.state.list));
        console.groupEnd();
        // IMPORTANT: Do NOT call this.props.onChange() here — avoids parent <-> child ping-pong loops
      });
    }
  }

  // Centralized emitter for user-driven changes (add/remove/edit)
  _emitChange(nextList) {
    this._lastNormValue = normalizeForCompare(nextList); // anticipate parent echo
    this.props.onChange?.(nextList);
  }

  removeItem(idx) {
    const validationFailedDelta = this.props.validationFailed ? [...this.props.validationFailed] : [];
    delete validationFailedDelta[idx];
    this.props.onValidationChange?.(validationFailedDelta);

    this.setState(state => {
      const items = [...state.list];
      delete items[idx]; // keep holes
      return { list: items };
    }, () => {
      console.log(`${dbg(this.props.id)} removeItem(${idx}) -> non-empty len:`, this.state.list.filter(Boolean).length);
      this._emitChange(this.state.list);
    });
  }

  addItem() {
    this.setState(state => {
      const next = { key: state.keyCounter, ...(this.props.default || {}) };
      return { list: [...state.list, next], keyCounter: state.keyCounter + 1 };
    }, () => {
      console.log(`${dbg(this.props.id)} addItem -> len:`, this.state.list.filter(Boolean).length);
      this._emitChange(this.state.list);
    });
  }

  onItemChange(idx, field, value) {
    this.setState(state => {
      const items = [...state.list];
      if (!items[idx]) items[idx] = { key: state.keyCounter, ...(this.props.default || {}) };
      if (items[idx].key === undefined) items[idx].key = state.keyCounter;
      items[idx][field] = (value === undefined ? null : value);
      const nextKey = (items[idx].key === state.keyCounter) ? state.keyCounter + 1 : state.keyCounter;
      return { list: items, keyCounter: nextKey };
    }, () => {
      console.log(`${dbg(this.props.id)} onItemChange idx=${idx}, field=${field} ->`, this.state.list[idx]);
      this._emitChange(this.state.list);
    });
  }

  render () {
    const { id, label, actionLabel, formclass, emptyStateString, helperText, validationFailed, onValidationChange } = this.props;
    const { list } = this.state;

    const ItemType = resolveItemType(this.props.itemcomponent);
    if (!ItemType) {
      console.error(`${dbg(id)} Invalid itemcomponent provided:`, this.props.itemcomponent);
    } else {
      const labelName = (ItemType && (ItemType.displayName || ItemType.name)) || typeof ItemType;
      console.log(`${dbg(id)} resolved itemcomponent ->`, labelName);
    }

    const hasAny = list.some(item => item !== undefined);

    return (
      <FormFieldGroup header={
        <FormFieldGroupHeader
          titleText={{ text: label }}
          actions={<Button variant="secondary" className="btn-add" onClick={this.addItem}>{actionLabel}</Button>}
        />
      } className={"dynamic-form-group " + (formclass || "")}>
        {
          hasAny
            ? <>
              {list.map((item, idx) => {
                if (item === undefined) return null;
                if (!ItemType) return null;
                try {
                  return React.createElement(ItemType, {
                    idx,
                    item,
                    id: id + "-" + idx,
                    key: item.key ?? idx,
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
                } catch (e) {
                  console.error(`${dbg(id)} row render failed at idx=${idx}`, { error: e, item, ItemType });
                  return null;
                }
              })}
              {helperText &&
                <HelperText>
                  <HelperTextItem>{helperText}</HelperTextItem>
                </HelperText>
              }
            </>
            : <EmptyState>
              <EmptyStateBody>
                {emptyStateString}
              </EmptyStateBody>
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
  itemcomponent: PropTypes.oneOfType([PropTypes.elementType, PropTypes.element]).isRequired,
  formclass: PropTypes.string,
  options: PropTypes.object,
  validationFailed: PropTypes.array,
  onValidationChange: PropTypes.func,
  default: PropTypes.object,
  value: PropTypes.array,
};
