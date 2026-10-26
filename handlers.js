// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import GObject from 'gi://GObject';

// The dock supports replacing vfuncs in GObject classes and we need
// this to monkey them.
const {_gi: Gi} = imports;

export const SignalsHandlerFlags = Object.freeze({
    NONE: 0,
    CONNECT_AFTER: 1,
});

const GENERIC_KEY = Symbol('generic');

/**
 * Simplify global signals and function injections handling
 * abstract class
 */
const BasicHandler = class BasicHandler {
    static get genericKey() {
        return GENERIC_KEY;
    }

    constructor(parentObject) {
        this._storage = Object.create(null);

        if (parentObject) {
            if (!(parentObject.connect instanceof Function))
                throw new TypeError('Not a valid parent object');

            if (!(parentObject instanceof GObject.Object) ||
                GObject.signal_lookup('destroy', parentObject.constructor.$gtype)) {
                this._parentObject = parentObject;
                this._connectToParentDestroy();
            }
        }
    }

    _connectToParentDestroy() {
        const parentObject = this._parentObject;
        this._destroyId = parentObject.connect('destroy', () => {
            this._onParentDestroy(parentObject);
            this._parentObject = null;
            this._destroyId = 0;
            this.destroy();
        });
    }

    add(...args) {
        // Convert arguments object to array, concatenate with generic
        // Call addWithLabel with ags as if they were passed arguments
        this.addWithLabel(GENERIC_KEY, ...args);
    }

    clear() {
        Object.getOwnPropertySymbols(this._storage).forEach(label =>
            this.removeWithLabel(label));
    }

    destroy() {
        const parentObject = this._parentObject;
        const destroyId = this._destroyId;
        this._parentObject = null;
        this._destroyId = 0;

        if (destroyId)
            parentObject.disconnect(destroyId);

        this.clear();
    }

    _onParentDestroy(_parentObject) {
    }

    block() {
        Object.getOwnPropertySymbols(this._storage).forEach(label =>
            this.blockWithLabel(label));
    }

    unblock() {
        Object.getOwnPropertySymbols(this._storage).forEach(label =>
            this.unblockWithLabel(label));
    }

    addWithLabel(label, ...args) {
        if (typeof label !== 'symbol')
            throw new Error(`Invalid label ${label}, must be a symbol`);

        let argsArray = [...args];
        if (argsArray.every(arg => !Array.isArray(arg)))
            argsArray = [argsArray];

        if (this._storage[label] === undefined)
            this._storage[label] = [];

        // Skip first element of the arguments
        for (const argArray of argsArray) {
            if (argArray.length < 3)
                throw new Error('Unexpected number of arguments');
            const item = this._storage[label];
            try {
                item.push(this._create(...argArray));
            } catch (e) {
                logError(e);
            }
        }
    }

    removeWithLabel(label) {
        this._storage[label]?.reverse().forEach(item => this._remove(item));
        delete this._storage[label];
    }

    blockWithLabel(label) {
        (this._storage[label] || []).forEach(item => this._block(item));
    }

    unblockWithLabel(label) {
        (this._storage[label] || []).forEach(item => this._unblock(item));
    }

    _removeByItem(item) {
        Object.getOwnPropertySymbols(this._storage).forEach(label =>
            (this._storage[label] = this._storage[label].filter(it => {
                if (!this._itemsEqual(it, item))
                    return true;
                this._remove(item);
                return false;
            })));
    }

    // Virtual methods to be implemented by subclass

    /**
     * Create single element to be stored in the storage structure
     *
     * @param _object
     * @param _element
     * @param _callback
     */
    _create(_object, _element, _callback) {
        throw new GObject.NotImplementedError(`_create in ${this.constructor.name}`);
    }

    /**
     * Correctly delete single element
     *
     * @param _item
     */
    _remove(_item) {
        throw new GObject.NotImplementedError(`_remove in ${this.constructor.name}`);
    }

    /**
     * Block single element
     *
     * @param _item
     */
    _block(_item) {
        throw new GObject.NotImplementedError(`_block in ${this.constructor.name}`);
    }

    /**
     * Unblock single element
     *
     * @param _item
     */
    _unblock(_item) {
        throw new GObject.NotImplementedError(`_unblock in ${this.constructor.name}`);
    }

    _itemsEqual(itemA, itemB) {
        if (itemA === itemB)
            return true;

        if (itemA.length !== itemB.length)
            return false;

        return itemA.every((_, idx) => itemA[idx] === itemB[idx]);
    }
};

/**
 * Manage global signals
 */
export class GlobalSignalsHandler extends BasicHandler {
    _create(object, event, callback, flags = SignalsHandlerFlags.NONE) {
        if (!object)
            throw new Error('Impossible to connect to an invalid object');

        const after = flags === SignalsHandlerFlags.CONNECT_AFTER;
        const connector = after ? object.connect_after : object.connect;

        if (!connector) {
            throw new Error(`Requested to connect to signal '${event}', ` +
                `but no implementation for 'connect${after ? '_after' : ''}' ` +
                `found in ${object.constructor.name}`);
        }

        const isDestroy = event === 'destroy';
        const isParentObject = object === this._parentObject;

        if (isDestroy && !isParentObject) {
            const originalCallback = callback;
            callback = (...args) => {
                this._removeForObject(object);
                originalCallback(...args);
            };
        }
        const id = connector.call(object, event, callback);

        if (isDestroy && isParentObject) {
            this._parentObject.disconnect(this._destroyId);
            this._connectToParentDestroy();
        } else if (!isParentObject && !isDestroy) {
            this._monitorDestruction(object);
        }

        return [object, id];
    }

    _monitorDestruction(object) {
        if (!(object instanceof GObject.Object) ||
            !GObject.signal_lookup('destroy', object.constructor.$gtype))
            return;

        this._destroyHandlersIds ??= new Map();
        if (this._destroyHandlersIds.has(object))
            return;

        const connector = object.connect_after ?? object.connect;
        const id = connector.call(object, 'destroy',
            () => this._removeForObject(object, false));
        this._destroyHandlersIds.set(object, id);
    }

    _removeForObject(object, disconnect = true) {
        Object.getOwnPropertySymbols(this._storage).forEach(label =>
            (this._storage[label] = this._storage[label].filter(it => {
                if (it[0] !== object)
                    return true;
                if (disconnect)
                    this._remove(it);
                return false;
            })));

        const monitorId = this._destroyHandlersIds?.get(object);
        if (monitorId) {
            this._destroyHandlersIds.delete(object);
            if (disconnect)
                object.disconnect(monitorId);
        }
    }

    clear() {
        super.clear();
        this._destroyHandlersIds?.forEach((id, object) => object.disconnect(id));
        this._destroyHandlersIds?.clear();
    }

    _onParentDestroy(parentObject) {
        this._removeForObject(parentObject, false);
    }

    _remove(item) {
        const [object, id] = item;
        object.disconnect(id);
    }

    _block(item) {
        const [object, id] = item;

        if (object instanceof GObject.Object)
            GObject.Object.prototype.block_signal_handler.call(object, id);
    }

    _unblock(item) {
        const [object, id] = item;

        if (object instanceof GObject.Object)
            GObject.Object.prototype.unblock_signal_handler.call(object, id);
    }
}

/**
 * Color manipulation utilities
 */
export class InjectionsHandler extends BasicHandler {
    _create(object, name, injectedFunction) {
        const original = object[name];

        if (!(original instanceof Function))
            throw new Error(`Function ${name}() is not available for ${object}`);

        object[name] = function (...args) {
            return injectedFunction.call(this, original, ...args);
        };
        return [object, name, original];
    }

    _remove(item) {
        const [object, name, original] = item;
        object[name] = original;
    }
}

/**
 * Manage vfunction injection: both instances and prototype can be overridden
 * and restored
 */
export class VFuncInjectionsHandler extends BasicHandler {
    _create(prototype, name, injectedFunction) {
        const original = prototype[`vfunc_${name}`];
        if (!(original instanceof Function))
            throw new Error(`Virtual function ${name} is not available for ${prototype}`);
        this._replaceVFunc(prototype, name, injectedFunction);
        return [prototype, name];
    }

    _remove(item) {
        const [prototype, name] = item;
        const originalVFunc = prototype[`vfunc_${name}`];
        try {
            // This may fail if trying to reset to a never-overridden vfunc
            // as gjs doesn't consider it a function, even if it's true that
            // originalVFunc instanceof Function.
            this._replaceVFunc(prototype, name, originalVFunc);
        } catch {
            try {
                this._replaceVFunc(prototype, name, function (...args) {
                    // eslint-disable-next-line no-invalid-this
                    return originalVFunc.call(this, ...args);
                });
            } catch (e) {
                logError(e, `Removing vfunc_${name}`);
            }
        }
    }

    _replaceVFunc(prototype, name, func) {
        // shexli-ci: EGO-I-004 - required to override vfuncs
        if (Gi.gobject_prototype_symbol && Gi.gobject_prototype_symbol in prototype) {
            // shexli-ci: EGO-I-004 - override vfuncs
            prototype = prototype[Gi.gobject_prototype_symbol];
        }

        // shexli-ci: EGO-I-004 - override vfuncs
        return prototype[Gi.hook_up_vfunc_symbol](name, func);
    }
}

/**
 * Manage properties injection: both instances and prototype can be overridden
 * and restored
 */
export class PropertyInjectionsHandler extends BasicHandler {
    constructor(parentObject, params) {
        super(parentObject);
        this._params = params;
    }

    _create(instance, name, injectedPropertyDescriptor) {
        if (!this._params?.allowNewProperty && !(name in instance))
            throw new Error(`Object ${instance} has no '${name}' property`);

        const {prototype} = instance.constructor;
        const originalPropertyDescriptor = Object.getOwnPropertyDescriptor(prototype, name) ??
            Object.getOwnPropertyDescriptor(instance, name);

        const isAccessor = 'get' in injectedPropertyDescriptor ||
            'set' in injectedPropertyDescriptor;

        injectedPropertyDescriptor = {
            ...originalPropertyDescriptor,
            ...injectedPropertyDescriptor,
            ...{configurable: true},
        };

        if (isAccessor) {
            delete injectedPropertyDescriptor.value;
            delete injectedPropertyDescriptor.writable;
        } else {
            delete injectedPropertyDescriptor.get;
            delete injectedPropertyDescriptor.set;
        }

        Object.defineProperty(instance, name, injectedPropertyDescriptor);
        return [instance, name, originalPropertyDescriptor];
    }

    _remove(item) {
        const [instance, name, originalPropertyDescriptor] = item;
        if (originalPropertyDescriptor)
            Object.defineProperty(instance, name, originalPropertyDescriptor);
        else
            delete instance[name];
    }
}
