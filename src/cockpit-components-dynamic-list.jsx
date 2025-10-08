import React from 'react';
import PropTypes from 'prop-types';
import { Button } from "@patternfly/react-core/dist/esm/components/Button";
import { EmptyState, EmptyStateBody } from "@patternfly/react-core/dist/esm/components/EmptyState";
import { FormFieldGroup, FormFieldGroupHeader } from "@patternfly/react-core/dist/esm/components/Form";
import { HelperText, HelperTextItem } from "@patternfly/react-core/dist/esm/components/HelperText";

import './cockpit-components-dynamic-list.scss';

/* Dynamic list with a variable number of rows. Each row is a custom component, usually input field(s).
 *
 * Props:
 *   - emptyStateString
 *   - onChange(list)
 *   - id
 *   - itemcomponent (React element type)
 *   - formclass (optional)
 *   - options (optional)
 *   - onValidationChange: A handler function which updates the parent's validation object.
 *                         Parameter is an array with the same structure as 'validationFailed'.
 *   - validationFailed: Array; each item represents validation result for the row at the same index.
 *   - default: shape of a brand-new row when clicking "Add"
 *   - value: initial/controlled list to render (NEW)  ←––––––––––––––––––––––––––––––––––––––
 */
export class DynamicListForm extends React.Component {
    constructor(props) {
        super(props);

        // Build initial list from props.value if provided; otherwise empty list.
        const { list, nextKey } = this._hydrateFromValue(props.value, 0, props.id);
        this.state = {
            list,           // [{ key, ...rowFields }, ...] holes allowed (deleted rows)
            keyCounter: nextKey,
        };

        this.removeItem = this.removeItem.bind(this);
        this.addItem = this.addItem.bind(this);
        this.onItemChange = this.onItemChange.bind(this);

        console.log(`[DynamicListForm:${props.id}] ctor -> value len: ${Array.isArray(props.value) ? props.value.length : 0}`);
    }

    /* Convert props.value (array of row objects) into our internal list that
       includes stable `key`s. Keeps existing keys if present; otherwise assigns. */
    _hydrateFromValue(value, startKey, idForLog) {
        const out = [];
        let k = startKey;

        if (Array.isArray(value) && value.length > 0) {
            value.forEach((row, idx) => {
                if (row === undefined || row === null) {
                    out[idx] = undefined; // preserve "holes"
                    return;
                }
                const withKey = { ...(row || {}) };
                if (withKey.key === undefined) withKey.key = k++;
                out[idx] = withKey;
            });
        }

        console.log(`[DynamicListForm:${idForLog}] hydrateFromValue -> rows: ${out.filter(Boolean).length}`);
        return { list: out, nextKey: k };
    }

    componentDidMount() {
        console.log(`[DynamicListForm:${this.props.id}] mounted with list length: ${this.state.list.filter(Boolean).length}`);
        // If a value prop exists and we didn’t reflect it (e.g. because it arrived late),
        // try to sync once on mount — safe no-op if already in sync.
        if (Array.isArray(this.props.value) && this.props.value.length > 0 && this.state.list.filter(Boolean).length === 0) {
            const { list, nextKey } = this._hydrateFromValue(this.props.value, this.state.keyCounter, this.props.id);
            this.setState({ list, keyCounter: nextKey }, () => {
                console.log(`[DynamicListForm:${this.props.id}] didMount sync -> list length: ${this.state.list.filter(Boolean).length}`);
                this.props.onChange?.(this.state.list);
            });
        }
    }

    componentDidUpdate(prevProps) {
        // Basic controlled sync: if parent changes `value` reference (or length), mirror it.
        const valueChanged =
            this.props.value !== prevProps.value ||
            (Array.isArray(this.props.value) && Array.isArray(prevProps.value) &&
             this.props.value.length !== prevProps.value.length);

        if (valueChanged) {
            const { list, nextKey } = this._hydrateFromValue(this.props.value, this.state.keyCounter, this.props.id);
            this.setState({ list, keyCounter: nextKey }, () => {
                console.log(`[DynamicListForm:${this.props.id}] props.value changed -> list length: ${this.state.list.filter(Boolean).length}`);
                this.props.onChange?.(this.state.list);
            });
        }
    }

    removeItem(idx) {
        const validationFailedDelta = this.props.validationFailed ? [...this.props.validationFailed] : [];
        // We also need to remove any error messages which the item (row) may have contained
        delete validationFailedDelta[idx];
        this.props.onValidationChange?.(validationFailedDelta);

        this.setState(state => {
            const items = [...state.list];
            // keep the list structure (sparse), otherwise indexes shift and key mapping breaks
            delete items[idx];
            return { list: items };
        }, () => {
            console.log(`[DynamicListForm:${this.props.id}] removeItem(${idx}) -> new length (non-empty): ${this.state.list.filter(Boolean).length}`);
            this.props.onChange?.(this.state.list);
        });
    }

    addItem() {
        this.setState(state => {
            const next = { key: state.keyCounter, ...(this.props.default || {}) };
            return { list: [...state.list, next], keyCounter: state.keyCounter + 1 };
        }, () => {
            console.log(`[DynamicListForm:${this.props.id}] addItem -> length now: ${this.state.list.filter(Boolean).length}`);
            this.props.onChange?.(this.state.list);
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
            // Emit full list with holes preserved
            console.log(`[DynamicListForm:${this.props.id}] onItemChange idx=${idx}, field=${field} ->`, this.state.list[idx]);
            this.props.onChange?.(this.state.list);
        });
    }

    render () {
        const { id, label, actionLabel, formclass, emptyStateString, helperText, validationFailed, onValidationChange } = this.props;
        const { list } = this.state;

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

                                return React.createElement(this.props.itemcomponent, {
                                    idx,
                                    item,
                                    id: id + "-" + idx,
                                    key: item.key ?? idx, // prefer stable internal key
                                    onChange: this.onItemChange,
                                    removeitem: this.removeItem,
                                    additem: this.addItem,
                                    options: this.props.options,
                                    validationFailed: validationFailed && validationFailed[idx],
                                    onValidationChange: value => {
                                        // Each row/item then consists of key-value pairs, which represent a field name and its validation error
                                        const delta = validationFailed ? [...validationFailed] : [];
                                        // Update validation of only a single row
                                        delta[idx] = value;

                                        // If a row doesn't contain any fields with errors anymore, delete the item of the array (keep holes)
                                        if (Object.keys(delta[idx] || {}).length === 0)
                                            delete delta[idx];

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
    itemcomponent: PropTypes.elementType.isRequired,
    formclass: PropTypes.string,
    options: PropTypes.object,
    validationFailed: PropTypes.array,
    onValidationChange: PropTypes.func,
    default: PropTypes.object,
    value: PropTypes.array, // NEW
};
