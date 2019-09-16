const { Identity } = require('./../shared-model/identity');
const { resolveValidationSetForFormDefinition } = require('./validation-set');
const { filterModelElementsForRelations, filterModelElementsForOwnerFields,
        filterModelElementsForStates, filterModelElementsForListingFilters,
        filterModelElementsForListingSortable, filterModelElementsForIdSequenceFields,
        filterModelElementsForDateTimeFields } = require('./utils');

const { processInstanceService, processDefinitionService, taskService } = require('camunda-workflow-service');

const { UserInputError } = require('apollo-server-express');
const { AuthorizationError, NotFoundError } = require('@pubsweet/errors');
const { pubsubManager } = require("pubsweet-server");
const GraphQLFields = require('graphql-fields');

const config = require("config");
const _ = require("lodash");

const logger = require('@pubsweet/logger');


const DebugAclRules = config.get("logging.debugAclRules") === true;

const AclActions = {
    Access: "access",
    Write: "write",
    Read: "read",

    Create: "create",
    Destroy: "destroy",

    Task: "task"
};

const CompleteTaskOutcome = {
    Success: 'Success',
    ValidatedEmailRequired: 'ValidatedEmailRequired',
    ValidationFailed: 'ValidationFailed'
};



const AdditionalAllowedGetFields = ['id', 'created', 'updated', 'tasks', 'restrictedFields'];

let InstanceResolverContextLookupUniqueId = 1;



function InstanceResolver(modelClass, taskDefinition, enums, lookupModel) {

    this.contextLookupId = InstanceResolverContextLookupUniqueId++;
    this.lookupModel = lookupModel;

    this.modelClass = modelClass;
    this.acl = modelClass.acl;

    this.extensions = (modelClass.extensions && modelClass.extensions.length) ? modelClass.extensions : null;
    this.specificExtensions = this.extensions ? {
        modifyListingQuery: this.extensions.map(ext => ext.modifyListingQuery).filter(f => !!f),
        modifyListingFilterQuery: this.extensions.map(ext => ext.modifyListingFilterQuery).filter(f => !!f),
        modifyListingFilterQueryForField: this.extensions.map(ext => ext.modifyListingFilterQueryForField).filter(f => !!f)
    } : {};

    this.taskDef = taskDefinition;
    this.modelDef = taskDefinition.model;
    this.enums = enums;

    this.relationFields = filterModelElementsForRelations(this.modelDef.elements, enums) || [];
    this.relationFieldNames = this.relationFields.map(e => e.field);
    this._resolvedRelationModels = false;

    this.ownerFields = filterModelElementsForOwnerFields(this.modelDef.elements);
    this.allowedReadFields = _allowedReadFieldKeysForInstance(this.modelDef);
    this.allowedInputFields = _allowedInputKeysForInstanceInput(this.modelDef);

    this.stateFields = filterModelElementsForStates(this.modelDef.elements, enums);
    this.listingFilterFields = filterModelElementsForListingFilters(this.modelDef.elements, enums);
    this.listingSortableFields = filterModelElementsForListingSortable(this.modelDef.elements, enums);

    this.idSequenceFields = filterModelElementsForIdSequenceFields(this.modelDef.elements, enums);
    this.dateTimeFields = filterModelElementsForDateTimeFields(this.modelDef.elements, enums);

    this.logPrefix = `[InstanceResolver/${taskDefinition.name}] `;
}


InstanceResolver.prototype._getEagerFieldsForQuery = function(topLevelFields) {

    // Models can specify what they want to have as automatic eager resolve sub-fields, we respect these and apply them
    // on top of the specified field name.

    if(!this._resolvedRelationModels) {
        this.relationFields.forEach(f => {
            f.model = this.lookupModel(f.type);
        });

        this._resolvedRelationModels = true;
    }

    const fields = this.relationFields.filter(f => topLevelFields.indexOf(f.field) !== -1);

    return fields.map(f => {
        const defaultEager = f.model.defaultEager || "";
        return (defaultEager && defaultEager.length) ? `${f.field}.${defaultEager}` : f.field;
    });
};


InstanceResolver.prototype.getAllowedReadFields = function(readAcl, includeAdditionalFields=true) {

    const allowedFields = (readAcl && readAcl.allowedFields) ? _.pick(this.allowedReadFields, readAcl.allowedFields) : Object.assign({}, this.allowedReadFields);

    if(includeAdditionalFields) {
        AdditionalAllowedGetFields.forEach(f => allowedFields[f] = true);
    }

    return allowedFields;
};


InstanceResolver.prototype._getInstance = function(instance, aclTargets, topLevelFields) {

    let aclMatch = null;

    if(this.acl) {
        aclMatch = this.acl.applyRules(aclTargets, AclActions.Read, instance);
        if(!aclMatch.allow) {
            return {id:instance.id, restrictedFields: topLevelFields.filter(f => f !== 'id')};
        }
    }

    const allowedFields = this.getAllowedReadFields(aclMatch, true);

    const filteredRequestedAllowedFields = topLevelFields.filter(f => allowedFields.hasOwnProperty(f));
    const r = {id:instance.id};

    filteredRequestedAllowedFields.forEach(f => {
        if(instance[f] !== undefined) {
            r[f] = instance[f];
        }
    });

    r.restrictedFields = topLevelFields.filter(f => !allowedFields.hasOwnProperty(f));
    if(!r.restrictedFields.length) {
        delete r.restrictedFields;
    }

    return r;
};


InstanceResolver.prototype.get = async function(input, info, context) {

    logger.debug(`${this.logPrefix} get [id: ${input.id}]`);

    const fieldsWithoutTypeName = GraphQLFields(info, {}, { excludedFields: ['__typename'] });
    const topLevelFields = fieldsWithoutTypeName ? Object.keys(fieldsWithoutTypeName) : [];
    let eagerResolves = null;

    if(this.relationFieldNames && this.relationFieldNames.length && fieldsWithoutTypeName) {
        eagerResolves = this._getEagerFieldsForQuery(topLevelFields);
    }

    const [object, user] = await Promise.all([
        this.modelClass.find(input.id, eagerResolves),
        this.resolveUserForContext(context)
    ]);

    if(!object) {
        return new NotFoundError("Instance not found.");
    }

    this.addInstancesToContext([object], context);

    const [aclTargets, isOwner] = this.userToAclTargets(user, object);

    if(this.acl) {

        const accessMatch = this.acl.applyRules(aclTargets, AclActions.Access, object);
        _debugAclMatching(user, aclTargets, isOwner, AclActions.Access, accessMatch);
        if(!accessMatch.allow) {
            throw new AuthorizationError("You do not have access to this object.");
        }

        if(!_restrictionsApplyToUser(accessMatch.allowedRestrictions, isOwner)) {
            throw new AuthorizationError("You do not have access to this object.");
        }
    }

    return this._getInstance(object, aclTargets, topLevelFields);
};


InstanceResolver.prototype.list = async function(input, info, context) {

    const fieldsWithoutTypeName = GraphQLFields(info, {}, { excludedFields: ['__typename'] });
    const topLevelFields = (fieldsWithoutTypeName && fieldsWithoutTypeName.results) ? Object.keys(fieldsWithoutTypeName.results) : [];
    const limit = input.first || 200;
    const offset = input.offset || 0;

    let eagerResolves = null;
    if(this.relationFieldNames && this.relationFieldNames.length && fieldsWithoutTypeName) {
        eagerResolves = this._getEagerFieldsForQuery(topLevelFields);
    }

    logger.debug(`${this.logPrefix} list (fields=${topLevelFields.length}, eager=[${eagerResolves ? eagerResolves.join(",") : ""}])`);

    const user = await this.resolveUserForContext(context);
    let allowedRestrictions;


    // For the current user, determine what level of access they are allowed on objects.
    // This will normally be either "all" for an admin user or "owner" if they are the submitter etc.

    if(this.acl) {

        const [aclTargets, _] = this.userToAclTargets(user, null);

        const accessMatch = this.acl.applyRules(aclTargets, AclActions.Access);
        _debugAclMatching(user, aclTargets, null, AclActions.Access, accessMatch);
        if(!accessMatch.allow) {
            throw new AuthorizationError("You do not have access to this object.");
        }

        allowedRestrictions = accessMatch.allowedRestrictions;

    } else {

        allowedRestrictions = ["all"];
    }


    // We need to modify the select query. First, restrict the select to only top level fields the user is interested in.
    // Second, we need to obtain the full count of results over the entire data set (not just the limited range).

    let addedWhereStatement = false;
    let query = this.modelClass.query();
    const filter = input.filter;

    const knex = this.modelClass.knex();

    const relationFieldNames = {};
    if(this.relationFieldNames) {
        this.relationFieldNames.forEach(f => relationFieldNames[f] = true);
    }

    const topLevelFieldsWithoutRelations = topLevelFields.filter(field => !relationFieldNames.hasOwnProperty(field));

    query = query.select(topLevelFieldsWithoutRelations).select(knex.raw('count(*) OVER() AS internal_full_count')).limit(limit).offset(offset);


    if(this.listingFilterFields && this.listingFilterFields.length && filter) {

        const filterExtensions = this.specificExtensions.modifyListingFilterQuery;
        const filterFieldExtensions = this.specificExtensions.modifyListingFilterQueryForField;

        query = query.where(b => {

            let builder = b;

            this.listingFilterFields.forEach(f => {

                if(filter[f.field] === undefined) {
                    return;
                }

                const v = filter[f.field];

                // If there are any extensions that seek to modify the "where" statement produced for a specific field
                // we can let them override it here. Extensions are performed on a first-in basis. Once one extension
                // overrides the field and modifies the query, all other processing for the field is terminated.

                if(filterFieldExtensions && filterFieldExtensions.length) {
                    for(let i = 0; i < filterFieldExtensions.length; i++) {
                        const r = filterFieldExtensions[i](builder, f, v, this.modelClass, filter);
                        if(r) {
                            builder = r;
                            addedWhereStatement = true;
                            return;
                        }
                    }
                }

                if (v !== null) {

                    if (f.listingFilterMultiple) {

                        if (v instanceof Array) {
                            builder = builder.whereIn(f.field, v);
                            addedWhereStatement = true;
                        }

                    } else {

                        if(v === false) {
                            builder = builder.where(bb => bb.where(f.field, false).orWhereNull(f.field));
                        } else {
                            builder = builder.where(f.field, v);
                        }
                        addedWhereStatement = true;

                    }

                } else {

                    builder = builder.whereNull(f.field);
                    addedWhereStatement = true;
                }
            });

            // Apply any filtering extensions (these are not field specific). All extensions which provide a
            // 'modifyListingFilterQuery' will have the extension applied, regardless whether or not another
            // extension has already performed a modification to the query.

            if(filterExtensions && filterExtensions.length) {
                for(let i = 0; i < filterExtensions.length; i++) {
                    const r = filterExtensions[i](builder, this.modelClass, filter);
                    if(r) {
                        builder = r;
                        addedWhereStatement = true;
                    }
                }
            }
        });
    }


    // ACL matching then needs to apply on a per object basis to determine what the user is allowed to see.
    // Because conditions can be applied, this can change on a per instance to instance basis.
    // An easy top level restriction to apply in the first instance however is to check to see if the user
    // isn't allowed access to all instances, if that is the case a where statement is constructed to restrict
    // to fields where the user is considered an "owner".

    // FIXME: we will need to include any variables within the ACL conditions inside the requested fields set
    // we may even need to figure out if it is possible to include conditions inside the where clauses that
    // represent the restrictions in place for the current user

    if(allowedRestrictions.indexOf("all") === -1) {

        if(!user) {
            throw new AuthorizationError("You must be a valid user ");
        }

        if(this.ownerFields && this.ownerFields.length) {

            const ownerFieldStatementBuilder = builder => {

                let b = builder;

                this.ownerFields.forEach((f, index) => {
                    if(index === 0) {
                        b = b.where(f.joinField, user.id);
                    } else {
                        b = b.orWhere(f.joinField, user.id);
                    }
                });
            };

            query = addedWhereStatement ? query.andWhere(ownerFieldStatementBuilder) : query.where(ownerFieldStatementBuilder);
        }
    }

    query = query.skipUndefined();


    // Apply any sorting
    const sorting = input.sorting;
    if(this.listingSortableFields && this.listingSortableFields.length && sorting) {

        const ordering = [];

        this.listingSortableFields.forEach(f => {

            if(sorting[f.field] === undefined) {
                return;
            }

            const v = sorting[f.field];
            if(typeof(v) !== "boolean") {
                return;
            }

            if(v) {
                ordering.push({ column: f.field, order: 'desc' });
            } else {
                ordering.push({ column: f.field });
            }
        });

        if(ordering.length) {
            query = query.orderBy(ordering);
        }
    }


    // Apply any extensions that wish to modify the listing query
    if(this.specificExtensions.modifyListingQuery) {
        this.specificExtensions.modifyListingQuery.forEach(ext => {

            const newQuery = ext(query, this.modelClass, input, topLevelFields, eagerResolves);
            if(newQuery) {
                query = newQuery;
            }
        });
    }


    // Eager resolve on any fields inside this request, we also restrict the fields returned down to those requested by the user.
    // If the eager resolve includes fields which happen to be another relation, then we automatically do a more expensive eager
    // resolve onto that field as well (but we don't restrict the fields returned from that request).

    if(eagerResolves) {

        const eagerResolveFields = this.relationFields.filter(f => eagerResolves.indexOf(f.field) !== -1);

        eagerResolveFields.forEach(eagerField => {

            // FIXME: if the eager field itself is a relation, we need to skip any field which is eager itself !!!

            const eagerFieldName = eagerField.field;
            const model = this.lookupModel(eagerField.type);
            const eagerFields = Object.keys(fieldsWithoutTypeName.results[eagerField.field]);

            if(model && model.relationFieldNames && model.relationFieldNames.length) {

                const modelRelationFieldNames = model.relationFieldNames;
                const nonRelationEagerFields = [];
                const relationEagerFields = [];

                eagerFields.forEach(f => {
                    if(modelRelationFieldNames.indexOf(f) !== -1) {
                        relationEagerFields.push(f);
                    } else {
                        nonRelationEagerFields.push(f);
                    }
                });

                if(nonRelationEagerFields.length) {
                    query = query.eager(eagerFieldName).modifyEager(eagerField.field, builder => builder.select(nonRelationEagerFields));
                }

                if(relationEagerFields.length) {
                    query = query.eager(relationEagerFields.length === 1 ? `${eagerFieldName}.${relationEagerFields[0]}` : `${eagerFieldName}.[${relationEagerFields.join(', ')}]`);
                }

            } else {

                query = query.eager(eagerFieldName).modifyEager(eagerFieldName, builder => builder.select(eagerFields));
            }
        });
    }


    const r = await query;
    this.addInstancesToContext(r, context);

    // For each result, we then apply read ACL rules to it, ensuring only the allowed fields are returned for each instance.
    const totalCount = (r && r.length ? r[0].internalFullCount : 0);

    const results = r.map(object => {
        const [aclTargets, _] = this.userToAclTargets(user, object);
        return this._getInstance(object, aclTargets, topLevelFields);
    });

    return {
        results,
        pageInfo: {
            totalCount,
            offset,
            pageSize: limit
        }
    };
};


InstanceResolver.prototype.resolveRelation = async function(element, parent, info, context) {

    // FIXME: when resolving relations, we need to resolve the model instance and gain access
    // to the instance resolver to allow for security ACLs to be applied

    if(!parent) {
        return null;
    }

    if(parent[element.field] !== undefined) {
        return parent[element.field];
    }

    if(parent.id) {
        const instance = await this.resolveInstanceUsingContext(parent.id, context);
        return instance.$relatedQuery(element.field);
    }

    return null;
};


InstanceResolver.prototype.update = async function _update(input, info, context) {

    if(this.modelDef.input !== true) {
        throw new Error("Model is not defined as an allowing updates.");
    }

    const [object, user] = await Promise.all([
        this.modelClass.find(input.id),
        this.resolveUserForContext(context)
    ]);


    let aclWriteMatch = null;

    if(this.acl) {

        const [aclTargets, isOwner] = this.userToAclTargets(user, object);

        const accessMatch = this.acl.applyRules(aclTargets, AclActions.Access, object);
        _debugAclMatching(user, aclTargets, isOwner, AclActions.Access, accessMatch);

        if(!accessMatch.allow) {
            throw new AuthorizationError("You do not have access to this object.");
        }

        if(!_restrictionsApplyToUser(accessMatch.allowedRestrictions, isOwner)) {
            throw new AuthorizationError("You do not have access to this object.");
        }

        aclWriteMatch = this.acl.applyRules(aclTargets, AclActions.Write, object);
        _debugAclMatching(user, aclTargets, isOwner, AclActions.Write, aclWriteMatch);

        if(!aclWriteMatch.allow) {
            throw new AuthorizationError("You do not have write access to this object.");
        }
    }

    const instanceId = input.id;
    delete input.id;

    // Create a listing of fields that can be updated, then we apply the update to the model object
    // provided that it is within the list of allowed fields.

    const allowedFields = (aclWriteMatch && aclWriteMatch.allowedFields) ? _.pick(this.allowedInputFields, aclWriteMatch.allowedFields) : this.allowedInputFields;
    const restrictedFields = [];

    Object.keys(input).forEach(key => {
        if(allowedFields.hasOwnProperty(key)) {
            object[key] = input[key];
        } else {
            restrictedFields.push(key);
        }
    });

    if(restrictedFields.length) {
        throw new AuthorizationError(`You do not have write access on the following fields: ${restrictedFields.join(", ")}`);
    }

    await object.save();
    await this.publishInstanceWasModified(instanceId);
    return true;
};


InstanceResolver.prototype.create = async function create(context) {

    // Create a new instance and assign default values to it.
    const newInstance = new this.modelClass({
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
    });


    // We need to check that the current user is allowed to create an instance of the defined type.
    const user = await this.resolveUserForContext(context);
    if(this.acl) {

        const [aclTargets, _] = this.userToAclTargets(user, newInstance);

        const match = this.acl.applyRules(aclTargets, AclActions.Create, newInstance);
        _debugAclMatching(user, aclTargets, null, AclActions.Create, match);

        if(!match.allow) {
            throw new AuthorizationError("You do not have rights to create a new instance.");
        }
    }


    // If there is a current user, and the instance has an owner field(s), then we can connect those to the
    // identity that is creating the instance.

    if(user && user.id && this.ownerFields && this.ownerFields.length) {
        this.ownerFields.forEach(e => {
            newInstance[e.joinField] = user.id;
        });
    }


    // If the model definition has any default values that need to be applied (including enums), then we
    // can go through and apply these now to the new instance.

    if(this.modelDef && this.modelDef.elements) {

        this.modelDef.elements.forEach(e => {

            if(e.defaultEnum && e.defaultEnumKey) {

                const v = this.resolveEnum(e.defaultEnum, e.defaultEnumKey);
                if(v) {
                    newInstance[e.field] = v;
                }

            } else if(e.defaultValue) {

                newInstance[e.field] = e.defaultValue;
            }
        });
    }

    await newInstance.save();

    const { processKey } = this.taskDef.options;
    const createProcessOpts = {
        key: processKey,
        businessKey: newInstance.id
    };

    return processDefinitionService.start(createProcessOpts).then(async data => {

        await this.publishInstanceWasCreated(newInstance.id);
        return newInstance;
    });
};


InstanceResolver.prototype.destroy = async function(input, context) {

    // FIXME: maybe the state changes that are allowed to be applied here will need to be filtered down
    // to a specific set of allowed values based on the user, current phase etc.

    const [object, user] = await Promise.all([
        this.modelClass.find(input.id),
        this.resolveUserForContext(context)
    ]);

    if(!object) {
        throw new Error("Instance with identifier not found.");
    }

    // Destroy acl processing is applied before the state changes get applied.
    if(this.acl) {

        const [aclTargets, isOwner] = this.userToAclTargets(user, object);

        const accessMatch = this.acl.applyRules(aclTargets, AclActions.Access, object);
        _debugAclMatching(user, aclTargets, isOwner, AclActions.Access, accessMatch);
        if(!accessMatch.allow) {
            throw new AuthorizationError("You do not have access to this object.");
        }

        if(!_restrictionsApplyToUser(accessMatch.allowedRestrictions, isOwner)) {
            throw new AuthorizationError("You do not have access to this object.");
        }

        const destroyAclMatch = this.acl.applyRules(aclTargets, AclActions.Destroy, object);
        _debugAclMatching(user, aclTargets, isOwner, AclActions.Destroy, destroyAclMatch);
        if(!destroyAclMatch.allow) {
            throw new AuthorizationError("You do not have the rights allowed to destroy this object.");
        }
    }

    // Process any state changes that need to be applied to the instance before destruction. This is
    // normally just changing the phase/state enum to "destroyed" or something of that nature.
    // State fields are allowed to be changed during a destruction request (write-acl is not applied to
    // state fields).

    const { state } = input;
    const allowedKeys = this.stateFields ? this.stateFields.map(e => e.field) : [];
    const filteredState = (state && allowedKeys && allowedKeys.length) ? _.pick(state, allowedKeys) : null;


    // If we have a state update to apply then we can do this here and now to the object in question.
    if(filteredState && Object.keys(filteredState).length) {

        let didModify = false;

        Object.keys(filteredState).forEach(key => {

            const value = filteredState[key];
            if(object[key] !== value) {
                object[key] = value;
                didModify = true;
            }
        });

        if(didModify) {
            await object.save();
        }
    }

    // Fetch a listing of process instances (should be only one) that has the business key set to the instance id.

    const { processKey } = this.taskDef.options;
    const listOpts = {
        businessKey: input.id,
        processDefinitionKey: processKey
    };

    return processInstanceService.list(listOpts).then((data) => {

        if(data && data.length) {

            const processInstance = data[0];

            if(processInstance && processInstance.id && processInstance.businessKey && processInstance.businessKey.toLowerCase() === input.id.toLowerCase()) {

                logger.debug(`${this.logPrefix} deleting process instance [${processInstance.id}] from business process engine.`);

                return new Promise((resolve, reject) => {

                    processInstanceService.http.del(processInstanceService.path +'/' + processInstance.id, {
                        done: function(err, result) {
                            if (err) {
                                return reject(err);
                            }
                            return resolve(true);
                        }
                    });
                });
            }
        }

        return false;

    }).then(async r => {

        await this.publishInstanceWasModified(input.id);
        return r;

    }).catch((err) => {

        logger.error(`[InstanceResolver/Destroy] BPM engine request failed due to: ${err.toString()}`);
        return Promise.reject(new Error("Unable to destroy instance due to business engine error."));
    });
};


InstanceResolver.prototype.restart = async function restart(instance, startAfterActivityId) {

    // If we have a state update to apply then we can do this here and now.
    const { processKey } = this.taskDef.options;
    const createProcessOpts = {
        key: processKey,
        businessKey: instance.id,
        startInstructions:[
            {
                type: "startAfterActivity",
                activityId: startAfterActivityId
            }
        ]
    };

    if(this.stateFields && this.stateFields.length) {

        const variables = {};
        let hasVariables = false;

        this.stateFields.forEach(f => {

            const value = instance[f.field];

            if(typeof(value) === "string" || typeof(value) === "number" || value === null) {
                variables[f.field] = {value: value};
                hasVariables = true;
            }
        });

        if(hasVariables) {
            createProcessOpts.variables = variables;
        }
    }

    return processDefinitionService.start(createProcessOpts).then(async data => {

        await this.publishInstanceWasModified(instance.id);
        return data;

    }).catch((err) => {

        logger.error("BPM engine request failed due to: " + err.toString());
        return Promise.reject(new Error("Unable to restart instance due to business engine error."));
    });
};


InstanceResolver.prototype.getTasks = async function getTasks(instanceID, context) {

    // FIXME: this should use the parent context, if that has resolved the user and object already then we shouldn't need
    // to re-fetch them

    const [object, user] = await Promise.all([
        this.modelClass.find(instanceID),
        this.resolveUserForContext(context)
    ]);

    if(!object) {
        throw new NotFoundError("Instance with identifier not found.");
    }

    let tasksAclMatch = null;

    // Destroy acl processing is applied before the state changes get applied.
    if(this.acl) {

        const [aclTargets, isOwner] = this.userToAclTargets(user, object);

        tasksAclMatch = this.acl.applyRules(aclTargets, AclActions.Task, object);
        _debugAclMatching(user, aclTargets, isOwner, AclActions.Task, tasksAclMatch);
        if(!tasksAclMatch.allow) {
            throw new AuthorizationError("You do not have the rights allowed to destroy this object.");
        }
    }

    // Fetch the listing of tasks associated with the instance.
    const taskOpts = {processInstanceBusinessKey:instanceID};

    return taskService.list(taskOpts).then((data) => {

        const tasks = data._embedded.tasks || data._embedded.task;

        tasks.forEach(task => {
            delete task._links;
            delete task._embedded;
        });

        // Filter tasks if required down to allowed task types.
        if(tasksAclMatch && tasksAclMatch.allowedTasks) {
            return tasks.filter(t => tasksAclMatch.allowedTasks.indexOf(t.taskDefinitionKey) !== -1);
        }

        return tasks;

    }).catch((err) => {

        logger.error("BPM engine request failed due to: " + err.toString());
        return Promise.reject(new Error("Unable to fetch tasks for instance due to business engine error."));
    });
};


InstanceResolver.prototype.tasksForInstance = async function(instance) {

    const taskOpts = {processInstanceBusinessKey:instance.id};

    return taskService.list(taskOpts).then((data) => {

        return data._embedded.tasks || data._embedded.task;

    }).catch((err) => {

        logger.error("BPM engine request failed due to: " + err.toString());
        return Promise.reject(new Error("Unable to fetch tasks for instance due to business engine error."));
    });
};


InstanceResolver.prototype.completeTaskForInstance = async function(instance, taskId, stateChanges) {

    // Note: this complete task method is not hooked to a form definition, therefore any enforced state changes
    // or submission ID assignment will not occur.

    const completeTaskOpts = {id: taskId};
    let didModify = false;
    const newVars = {};

    Object.keys(stateChanges).forEach(key => {

        const value = stateChanges[key];

        if(typeof(value) === "string" || typeof(value) === "number" || value === null) {
            newVars[key] = {value: value};
        }
    });

    completeTaskOpts.variables = newVars;
    if(didModify) {
        await instance.save();
    }

    return taskService.complete(completeTaskOpts).then(() => {

        return this.publishInstanceWasModified(instance.id);

    }).catch((err) => {

        logger.error(`Unable to complete business process engine task due to error: ${err.toString()}`);
        throw new Error("Unable to complete task for instance due to business engine error.");
    });
};



InstanceResolver.prototype.completeTask = async function completeTask({id, taskId, form, outcome, state}, context) {

    if(!id || !taskId || !form || !outcome) {
        throw new UserInputError("Complete Task requires an instance id, task id, form and outcome to be supplied");
    }

    const formDefinition = this.taskDef.forms ? this.taskDef.forms.find(f => f.form === form) : null;
    if(!formDefinition) {
        throw new Error("Form is not defined for this instance type.");
    }

    const outcomeDefinition = formDefinition.outcomes ? formDefinition.outcomes.find(o => o.type === outcome) : null;
    if(!outcomeDefinition) {
        throw new Error("Outcome is not defined within form definition for this instance type.");
    }

    if(outcomeDefinition.result !== 'Complete') {
        throw new Error('Form outcome result type is not a complete task type.');
    }

    const validationSet = resolveValidationSetForFormDefinition(formDefinition, this.taskDef, this.enums);
    const taskOpts = {processInstanceBusinessKey:id};
    let eagerResolves = [];
    let tasksAclMatch = null;


    // If there are relation fields and the validation set has bindings to apply checks against a relation
    // (like the number of files etc) then we need to perform an eager resolve on those when finding the
    // instance.

    if(this.relationFieldNames && this.relationFieldNames.length && validationSet) {
        const validationSetBindings = validationSet.bindings();
        eagerResolves = this.relationFieldNames.filter(f => validationSetBindings.indexOf(f) !== -1);
    }

    const [instance, user, tasks] = await Promise.all([
        this.modelClass.find(id, eagerResolves),
        this.resolveUserForContext(context),
        taskService.list(taskOpts).then((data) => {
            const tasks = data._embedded.tasks || data._embedded.task;
            return (tasks || []).filter(t => t.id === taskId);

        })
    ]);

    if(!instance) {
        throw new Error("Instance with identifier not found.");
    }

    if(!tasks || !tasks.length) {
        throw new Error("Specific task not found for instance.");
    }


    // Apply ACL matching against this specific operation (access and then task completion) for the user.
    // Task filtering is also applied potentially based on the task ACL (i.e. a submitter can only complete a
    // submit task on the submission).

    if(this.acl) {

        const [aclTargets, isOwner] = this.userToAclTargets(user, instance);

        const accessMatch = this.acl.applyRules(aclTargets, AclActions.Access, instance);
        _debugAclMatching(user, aclTargets, isOwner, AclActions.Access, accessMatch);
        if(!accessMatch.allow) {
            throw new AuthorizationError("You do not have access to this object.");
        }

        if(!_restrictionsApplyToUser(accessMatch.allowedRestrictions, isOwner)) {
            throw new AuthorizationError("You do not have access to this object.");
        }

        tasksAclMatch = this.acl.applyRules(aclTargets, AclActions.Task, instance);
        _debugAclMatching(user, aclTargets, isOwner, AclActions.Task, tasksAclMatch);
        if(!tasksAclMatch.allow) {
            throw new AuthorizationError("You do not have the rights allowed to destroy this object.");
        }
    }


    // If the outcome requires a validated submitter (i.e. identity with a validated email address)
    // then we enforce that here. A valid user is required by virtue of this condition.

    if(outcomeDefinition.requiresValidatedSubmitter === true) {

        if(!user) {
            throw new AuthorizationError("Task completion requires a validated submitter, no user authenticated.");
        }

        if(user.isValidatedEmail !== true) {
            logger.debug(`unable to complete task as identity didn't have validated email address (instanceId = ${id}, taskId = ${id}, userId = ${user.id})`);
            return CompleteTaskOutcome.ValidatedEmailRequired;
        }
    }


    const filteredTasks = (tasksAclMatch && tasksAclMatch.allowedTasks) ? tasks.filter(t => tasksAclMatch.allowedTasks.indexOf(t.taskDefinitionKey) !== -1) : tasks;
    if(!filteredTasks.length) {
        throw new AuthorizationError("You do not have access to the task associated with the instance.");
    }


    // If the task has associated validations applied to it, then we need to apply those as well.
    // If the outcome skips validations, then they aren't applied on the server either.

    if(validationSet && outcomeDefinition.skipValidations !== true && validationSet.evaluate(instance) !== true) {
        return CompleteTaskOutcome.ValidationFailed;
    }


    // We can now overlay the forced state changes that maybe present within the outcome definition.
    // Any state changes that are mandated in the workflow definitions are applied over top of the front-end
    // supplied state changes (which have already been filtered based on what they are allowed access to via ACLs).

    const allowedKeys = this.stateFields ? this.stateFields.map(e => e.field) : [];
    const filteredState = (state && allowedKeys && allowedKeys.length) ? _.pick(state, allowedKeys) : {};
    const completeTaskOpts = {id: taskId};

    if(outcomeDefinition.state) {

        const overriddenValues = {};

        Object.keys(outcomeDefinition.state).forEach(key => {

            const v = outcomeDefinition.state[key];
            if(!v) {
                return;
            }

            if(v.type === 'enum') {
                const enumParts = v.value.split('.');
                if(enumParts.length === 2) {
                    const resolvedEnumValue = this.resolveEnum(enumParts[0], enumParts[1]);
                    if(resolvedEnumValue) {
                        overriddenValues[key] = resolvedEnumValue;
                    }
                }
            } else if(v.type === 'simple' && v.hasOwnProperty('value')) {

                overriddenValues[key] = v.value;
            }
        });

        Object.assign(filteredState, overriddenValues);
    }


    // If the outcome definition includes id sequence applications, then we apply those now as well. We iterate all id sequence fields
    // and find matching fields associated with the outcome. For each we determine if the instance is missing a value for field, and
    // of they are, we perform a raw SQL statement to generate a new ID from a defined sequence,

    let didModify = false;

    if(this.idSequenceFields && this.idSequenceFields.length
        && outcomeDefinition.sequenceAssignment && outcomeDefinition.sequenceAssignment.length) {

        const idSequencesToAssign = this.idSequenceFields.filter(f => {
            return outcomeDefinition.sequenceAssignment.indexOf(f.field) !== -1 && !instance[f.field];
        });

        if(idSequencesToAssign.length) {

            const allSequences = idSequencesToAssign.map(assignment => {

                return instance.$knex().raw(`SELECT TO_CHAR(nextval('${assignment.idSequence}'::regclass),'"S"fm000000') as id;`).then(resp => {
                    return {field:assignment.field, value:resp.rows[0].id};
                });
            });

            const r = await Promise.all(allSequences);

            r.forEach(a => {
                instance[a.field] = a.value;
                didModify = true;
            });
        }
    }


    // Iterate any date time fields that need to be assigned an updated value based on the completion of this task. Currently,
    // only "current" type updates are supported.

    if(this.dateTimeFields && this.dateTimeFields.length && outcomeDefinition.dateAssignments && outcomeDefinition.dateAssignments.length) {

        const dtFields = this.dateTimeFields.map(f => f.field);

        const dateFieldsToAssign = outcomeDefinition.dateAssignments.filter(f => {
            return dtFields.indexOf(f.field) !== -1;
        });

        dateFieldsToAssign.forEach(dateField => {
            instance[dateField.field] = new Date();
            didModify = true;
        });
    }


    // If we have a state update to apply to the instance, then we can do this here and now.
    // The final state changes here are the user supplied states changes filtered down to fields which are marked
    // as state, which the user has access to and then any forced state changes applied over top.

    if(filteredState && Object.keys(filteredState).length) {

        const newVars = {};

        Object.keys(filteredState).forEach(key => {

            const value = filteredState[key];

            if(instance[key] !== value) {
                instance[key] = value;
                didModify = true;
            }

            if(typeof(value) === "string" || typeof(value) === "number" || value === null) {
                newVars[key] = {value: value};
            }
        });

        completeTaskOpts.variables = newVars;
    }


    // Save any changes to the instance itself from the above processes (client state changes, overlaid forced
    // state changes and id sequence application).

    if(didModify) {
        await instance.save();
    }

    return taskService.complete(completeTaskOpts).then(data => {

        return this.publishInstanceWasModified(id);

    }).then(data => {

        return CompleteTaskOutcome.Success;

    }).catch((err) => {

        logger.error(`Unable to complete business process engine task due to error: ${err.toString()}`);
        throw new Error("Unable to complete task for instance due to business engine error.");
    });
};


InstanceResolver.prototype.publishInstanceWasCreated = async function(instanceId) {

    const pubSub = await pubsubManager.getPubsub();
    if(pubSub) {
        const r = {};
        r[`created${this.taskDef.name}`] = instanceId;
        pubSub.publish(`${this.taskDef.name}.created`, r);
    }
};

InstanceResolver.prototype.publishInstanceWasModified = async function(instanceId) {

    const pubSub = await pubsubManager.getPubsub();
    if(pubSub) {
        const r = {};
        r[`modified${this.taskDef.name}`] = instanceId;
        pubSub.publish(`${this.taskDef.name}.updated`, r);
    }
};


InstanceResolver.prototype.asyncIteratorWasCreated = async function() {

    const pubSub = await pubsubManager.getPubsub();
    return pubSub.asyncIterator(`${this.taskDef.name}.created`);
};

InstanceResolver.prototype.asyncIteratorWasModified = async function() {

    const pubSub = await pubsubManager.getPubsub();
    return pubSub.asyncIterator(`${this.taskDef.name}.updated`);
};





InstanceResolver.prototype.resolveInstanceUsingContext = async function(instanceId, context) {

    if(!context || !context.user) {
        return this.modelClass.find(instanceId);
    }

    if(!context.instanceLookup) {
        context.instanceLookup = {};
    }

    if(!context.instanceLookup[this.contextLookupId]) {
        context.instanceLookup[this.contextLookupId] = {};
    }

    const instanceLookupMap = context.instanceLookup[this.contextLookupId];

    if(instanceLookupMap[instanceId]) {
        return Promise.resolve(instanceLookupMap[instanceId]);
    }

    return this.modelClass.find(instanceId).then(instance => {
        instanceLookupMap[instanceId] = instance;
        return instance;
    });
};


InstanceResolver.prototype.addInstancesToContext = async function(instances, context) {

    if(instances && instances.length) {

        if(!context.instanceLookup) {
            context.instanceLookup = {};
        }

        if(!context.instanceLookup[this.contextLookupId]) {
            context.instanceLookup[this.contextLookupId] = {};
        }

        const instanceLookupMap = context.instanceLookup[this.contextLookupId];

        instances.forEach(instance => {

            const id = instance.id;
            if(id) {
                instanceLookupMap[id] = instance;
            }
        });
    }
};


InstanceResolver.prototype.resolveUserForContext = async function resolveUser(context) {

    if(!context || !context.user) {
        return null;
    }

    if(context.resolvedUser) {
        return context.resolvedUser;
    }

    return Identity.find(context.user).then((user) => {
        context.resolvedUser = user;
        return user;
    });
};


InstanceResolver.prototype.userToAclTargets = function(user, object) {

    // By default, everyone gets the "anonymous" role applied.

    const targets = ["anonymous"];
    let isOwner = false;

    // FIXME: important, all users are currently assigned admin access for testing and development purposes
    if(user && user.id) {
        targets.push("administrator");
    }

    if(user && user.id && object) {

        targets.push("user");

        this.ownerFields.forEach(field => {
            const ownerId = object[field.joinField];
            if(ownerId === user.id) {
                isOwner = true;
            }
        });

        if(isOwner) {
            targets.push("owner");
        }
    }

    return [targets, isOwner];
};


InstanceResolver.prototype.resolveEnum = function(enumName, enumKey) {

    if(this.enums && this.enums.hasOwnProperty(enumName)) {
        const e = this.enums[enumName];
        return e.values[enumKey];
    }
    return null;
};



function _restrictionsApplyToUser(restrictions, isOwner) {

    if(!restrictions || !restrictions.length) {
        return true;
    }

    if(restrictions.indexOf("all") !== -1) {
        return true;
    }

    return (isOwner && restrictions.indexOf("owner") !== -1);
}


function _allowedReadFieldKeysForInstance(model) {

    const allowedFields = {};

    model.elements.forEach(e => {
        if(e.field) {
            allowedFields[e.field] = e;
        }
    });

    return allowedFields;
}


function _allowedInputKeysForInstanceInput(model) {

    // For the model definition we want to determine the allowed input fields.

    const allowedInputFields = {};

    model.elements.forEach(e => {
        if(e.field && e.input !== false) {
            allowedInputFields[e.field] = e;
        }
    });

    return allowedInputFields;
}


function _debugAclMatching(user, userTargets, isOwner, action, match) {

    if(!DebugAclRules) {
        return;
    }

    console.log(`acl-match: action:(${action}) user(${user ? user.id : "anon"}) acl-targets:(${userTargets.join(", ")}) is-owner:(${isOwner ? "true" : "false"})`);
    if(match) {

        if(match.matchingRules) {
            match.matchingRules.forEach(rule => console.log(`\t+ ${rule.description()}`));
        } else {
            console.log(`\tno matching rules found`);
        }

        console.log(`\toutcome: ${match.allow ? "allow" : "disallow"}`);
    }
}



exports.InstanceResolver = InstanceResolver;
exports.AclActions = AclActions;
exports.debugAclMatching = _debugAclMatching;