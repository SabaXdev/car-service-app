const cds = require('@sap/cds');
const { SELECT, UPDATE, INSERT } = cds.ql;
const { applyEurConversion, roundMoney } = require('./lib/exchange-rates');

const ACTIVE_ORDER_STATUSES = ['OPEN', 'IN_PROGRESS'];
const TERMINAL_ORDER_STATUSES = ['COMPLETED', 'CANCELLED'];
const ORDER_NUMBER_ALLOCATION_RETRIES = 5;

const ITEM_PRICING = {
  LABOR: {
    amountField: 'hours',
    priceField: 'hourlyRate',
    clearFields: ['partPrice', 'quantity'],
    amountError: 'LABOR items require hours greater than zero.',
    priceError: 'LABOR items require a valid hourly rate.',
  },
  PART: {
    amountField: 'quantity',
    priceField: 'partPrice',
    clearFields: ['hours', 'hourlyRate'],
    amountError: 'PART items require quantity greater than zero.',
    priceError: 'PART items require a valid part price.',
  },
};

module.exports = class CarServiceService extends cds.ApplicationService {
  async init() {
    await super.init();

    const { ServiceOrders, ServiceItems, Vehicles, Mechanics } = this.entities;

    const orderTargets = [ServiceOrders, ServiceOrders.drafts].filter(Boolean);
    this.before(['CREATE', 'UPDATE', 'NEW'], orderTargets, this.onBeforeServiceOrderValidate);
    this.before(['CREATE', 'NEW'], orderTargets, this.onBeforeServiceOrderCreate);

    if (ServiceOrders.drafts) {
      this.before('SAVE', ServiceOrders.drafts, this.onBeforeServiceOrderDraftActivate);
    }

    const itemTargets = [ServiceItems, ServiceItems.drafts].filter(Boolean);
    this.before(['CREATE', 'UPDATE', 'NEW'], itemTargets, this.onBeforeServiceItemSave);
    this.before(['DELETE', 'CANCEL'], itemTargets, this.onBeforeServiceItemDelete);
    this.after(['CREATE', 'UPDATE', 'DELETE', 'NEW', 'CANCEL'], itemTargets, this.onAfterServiceItemChange);

    this.on('startService', ServiceOrders, this.onStartService);
    this.on('completeService', ServiceOrders, this.onCompleteService);
    this.on('cancelService', ServiceOrders, this.onCancelService);
    this.on('refreshExchangeRate', ServiceOrders, this.onRefreshExchangeRate);

    this.on('error', (err, req) => translateDatabaseError(err, req));
  }

  async onBeforeServiceOrderCreate(req) {
    const order = req.data;
    if (!order.orderNumber) {
      try {
        order.orderNumber = await allocateOrderNumber(this.entities.ServiceOrders);
      } catch (err) {
        if (err.status === 409) {
          return req.reject(409, err.message);
        }
        throw err;
      }
    }
    if (!order.status) {
      order.status = 'OPEN';
    }
  }

  async onBeforeServiceOrderDraftActivate(req) {
    const orderId = req.params?.[req.params.length - 1]?.ID;
    if (!orderId) {
      return req.reject(400, 'Service order key is missing.');
    }

    const { ServiceItems } = this.entities;
    const itemEntity = ServiceItems.drafts ?? ServiceItems;
    let items = await SELECT.from(itemEntity).where({ serviceOrder_ID: orderId });
    if (!items.length && ServiceItems.drafts) {
      items = await SELECT.from(ServiceItems).where({ serviceOrder_ID: orderId });
    }

    for (const item of items) {
      validateServiceItemPricing(req, item, { strict: true });
    }
  }

  async onBeforeServiceOrderValidate(req) {
    const order = req.data;
    const isCreate = req.event === 'CREATE' || req.event === 'NEW';
    const { ServiceOrders } = persistenceOf(this.entities, req);
    const { Vehicles, Mechanics } = this.entities;

    let existing;
    if (!isCreate) {
      const orderId = order.ID ?? req.params?.[req.params.length - 1]?.ID;
      existing = orderId
        ? await SELECT.one.from(ServiceOrders).where({ ID: orderId })
        : null;
      if (!existing) {
        return req.reject(404, 'Service order not found.');
      }
      if (order.status !== undefined && order.status !== existing.status) {
        return req.reject(
          400,
          'Service order status cannot be changed directly. Use startService, completeService, or cancelService.'
        );
      }
      delete order.status;

      if (TERMINAL_ORDER_STATUSES.includes(existing.status)) {
        return req.reject(400, `Cannot modify a ${existing.status} service order.`);
      }
    }

    if (isCreate && order.status && order.status !== 'OPEN') {
      return req.reject(400, 'New service orders must start in OPEN status. Use actions to change lifecycle.');
    }

    const serviceDate = toDate(order.serviceDate ?? existing?.serviceDate);
    if (!serviceDate) {
      return req.reject(400, 'Service date is required.');
    }
    if (isCreate && serviceDate < startOfToday()) {
      return req.reject(400, 'Service date cannot be in the past.');
    }

    let vehicleId = await resolveForeignKey(req, 'vehicle_ID', order.vehicle);
    let customerId = await resolveForeignKey(req, 'customer_ID', order.customer);
    let mechanicId = await resolveForeignKey(req, 'mechanic_ID', order.mechanic);

    if (!vehicleId && existing) {
      vehicleId = existing.vehicle_ID;
    }
    if (!customerId && existing) {
      customerId = existing.customer_ID;
    }
    if (mechanicId === undefined && existing && order.mechanic === undefined) {
      mechanicId = existing.mechanic_ID;
    }

    if (!vehicleId || !customerId) {
      return req.reject(400, 'Customer and vehicle are required.');
    }

    const mileageAtService = order.mileageAtService ?? existing?.mileageAtService;
    if (mileageAtService === undefined || mileageAtService === null) {
      return req.reject(400, 'Mileage at service is required.');
    }

    const vehicle = await SELECT.one.from(Vehicles).where({ ID: vehicleId });
    if (!vehicle) {
      return req.reject(404, 'Vehicle not found.');
    }
    if (String(vehicle.customer_ID) !== String(customerId)) {
      return req.reject(400, 'Selected vehicle does not belong to the selected customer.');
    }
    if (Number(mileageAtService) < Number(vehicle.currentMileage)) {
      return req.reject(
        400,
        `Mileage at service (${mileageAtService}) must be at least the vehicle current mileage (${vehicle.currentMileage}).`
      );
    }

    if (mechanicId) {
      await validateMechanicAssignment(req, {
        ServiceOrders,
        Mechanics,
        mechanicId,
        excludeOrderId: isCreate ? null : existing?.ID,
      });
    }

    order.serviceDate = formatDate(serviceDate);
    order.vehicle_ID = vehicleId;
    order.customer_ID = customerId;
    if (mechanicId) {
      order.mechanic_ID = mechanicId;
    }
    order.mileageAtService = Number(mileageAtService);
  }

  async onBeforeServiceItemSave(req) {
    const item = req.data;
    const isCreate = req.event === 'CREATE' || req.event === 'NEW';
    const { ServiceItems, ServiceOrders } = persistenceOf(this.entities, req);

    let serviceOrderId = await resolveForeignKey(req, 'serviceOrder_ID', item.serviceOrder);
    if (!isCreate) {
      const itemId = item.ID ?? req.params?.[req.params.length - 1]?.ID;
      const existing = itemId
        ? await SELECT.one.from(ServiceItems).where({ ID: itemId })
        : null;
      if (existing) {
        if (!serviceOrderId) {
          serviceOrderId = existing.serviceOrder_ID;
        }
        for (const key of ['itemType', 'hours', 'hourlyRate', 'quantity', 'partPrice', 'description']) {
          if (item[key] === undefined || item[key] === null) {
            item[key] = existing[key];
          }
        }
      }
    }

    if (serviceOrderId) {
      const order = await SELECT.one.from(ServiceOrders).where({ ID: serviceOrderId });
      if (order && TERMINAL_ORDER_STATUSES.includes(order.status)) {
        return req.reject(400, `Cannot change line items on a ${order.status} service order.`);
      }
    }

    priceServiceItem(req, item);
  }

  async onBeforeServiceItemDelete(req) {
    const { ServiceItems, ServiceOrders } = persistenceOf(this.entities, req);
    const itemId = req.data?.ID ?? req.params?.[req.params.length - 1]?.ID;
    if (!itemId) {
      return;
    }

    const existing = await SELECT.one.from(ServiceItems).where({ ID: itemId });
    if (!existing?.serviceOrder_ID) {
      return;
    }

    req.data.serviceOrder_ID = existing.serviceOrder_ID;

    const order = await SELECT.one.from(ServiceOrders).columns('status').where({ ID: existing.serviceOrder_ID });
    if (order && TERMINAL_ORDER_STATUSES.includes(order.status)) {
      return req.reject(400, `Cannot change line items on a ${order.status} service order.`);
    }
  }

  async onAfterServiceItemChange(item, req) {
    const persisted = persistenceOf(this.entities, req);
    const serviceOrderId =
      item?.serviceOrder_ID ??
      req.data?.serviceOrder_ID ??
      (await resolveOrderIdFromItemRequest(req, persisted.ServiceItems));

    if (serviceOrderId) {
      await recalculateOrderTotals(persisted, serviceOrderId, (message) => req.warn(message));
    }
  }

  async onStartService(req) {
    const { ServiceOrders, Mechanics } = this.entities;
    return moveServiceOrder(req, ServiceOrders, Mechanics, {
      allowed: ['OPEN'],
      nextStatus: 'IN_PROGRESS',
      invalidStatus: (status) => `Service order must be OPEN to start (current: ${status}).`,
      prepare: (order) => {
        if (!order.mechanic_ID) {
          return req.reject(400, 'Assign a mechanic before starting service.');
        }
      },
      after: (order) => syncMechanicStatus(Mechanics, ServiceOrders, order.mechanic_ID),
    });
  }

  async onCompleteService(req) {
    const { ServiceOrders, Vehicles, Mechanics } = this.entities;
    return moveServiceOrder(req, ServiceOrders, Mechanics, {
      allowed: ['IN_PROGRESS'],
      nextStatus: 'COMPLETED',
      invalidStatus: (status) => `Service order must be IN_PROGRESS to complete (current: ${status}).`,
      after: async (order) => {
        await UPDATE(Vehicles)
          .set({ currentMileage: order.mileageAtService })
          .where({ ID: order.vehicle_ID });
        if (order.mechanic_ID) {
          await syncMechanicStatus(Mechanics, ServiceOrders, order.mechanic_ID);
        }
      },
    });
  }

  async onCancelService(req) {
    const { ServiceOrders, Mechanics } = this.entities;
    return moveServiceOrder(req, ServiceOrders, Mechanics, {
      allowed: ['OPEN', 'IN_PROGRESS'],
      nextStatus: 'CANCELLED',
      invalidStatus: (status) => `Service order must be OPEN or IN_PROGRESS to cancel (current: ${status}).`,
      after: (order) => {
        if (order.mechanic_ID) {
          return syncMechanicStatus(Mechanics, ServiceOrders, order.mechanic_ID);
        }
      },
    });
  }

  async onRefreshExchangeRate(req) {
    const { ServiceOrders } = this.entities;
    const order = await loadServiceOrderByRequest(req, ServiceOrders);

    if (order.status === 'CANCELLED') {
      return req.reject(400, 'Cannot refresh exchange rate on a cancelled service order.');
    }

    const costs = { totalCostGEL: order.totalCostGEL, currency: 'GEL' };
    await applyEurConversion(costs, (message) => req.warn(message), { fresh: true });

    await UPDATE(ServiceOrders)
      .set({
        exchangeRate: costs.exchangeRate,
        totalCostEUR: costs.totalCostEUR,
      })
      .where({ ID: order.ID });

    return SELECT.one.from(ServiceOrders).where({ ID: order.ID });
  }
};

function isDraftRequest(req) {
  return req.event === 'NEW' || String(req.target?.name || '').endsWith('.drafts');
}

function persistenceOf(entities, req) {
  const draft = isDraftRequest(req);
  return {
    ServiceItems: draft && entities.ServiceItems.drafts ? entities.ServiceItems.drafts : entities.ServiceItems,
    ServiceOrders: draft && entities.ServiceOrders.drafts ? entities.ServiceOrders.drafts : entities.ServiceOrders,
  };
}

function isMechanicOnlyUser(req) {
  return req.user?.is?.('Mechanic') && !req.user?.is?.('Admin') && !req.user?.is?.('ServiceAdvisor');
}

async function assertMechanicOrderOwnership(req, order, Mechanics) {
  if (!isMechanicOnlyUser(req)) {
    return;
  }

  if (!order.mechanic_ID) {
    return req.reject(403, 'You are not assigned to this service order.');
  }

  const mechanic = await SELECT.one.from(Mechanics).where({ ID: order.mechanic_ID });
  const userId = req.user?.id;
  if (!mechanic?.authUser || mechanic.authUser !== userId) {
    return req.reject(403, 'You can only perform this action on service orders assigned to you.');
  }
}

function validateServiceItemPricing(req, item, { strict = false } = {}) {
  const itemType = (item.itemType || '').toUpperCase();
  const pricing = ITEM_PRICING[itemType];
  if (!pricing) {
    if (strict) {
      return req.reject(400, 'Item type must be LABOR or PART.');
    }
    return;
  }

  item.itemType = itemType;
  const amount = Number(item[pricing.amountField]);
  const price = Number(item[pricing.priceField]);
  const amountOk = Number.isFinite(amount) && amount > 0;
  const priceOk = Number.isFinite(price) && price >= 0;

  if (amountOk && priceOk) {
    item.lineTotal = roundMoney(amount * price);
    for (const field of pricing.clearFields) {
      item[field] = null;
    }
    return;
  }

  if (!strict) {
    return;
  }
  if (!amountOk) {
    return req.reject(400, pricing.amountError);
  }
  if (!priceOk) {
    return req.reject(400, pricing.priceError);
  }
}

function priceServiceItem(req, item) {
  validateServiceItemPricing(req, item, { strict: !isDraftRequest(req) });
}

async function recalculateOrderTotals(entities, serviceOrderId, warn) {
  const { ServiceOrders, ServiceItems } = entities;

  const items = await SELECT.from(ServiceItems).where({ serviceOrder_ID: serviceOrderId });

  let laborCost = 0;
  let partsCost = 0;
  for (const row of items) {
    const lineTotal = Number(row.lineTotal) || 0;
    if (row.itemType === 'LABOR') {
      laborCost += lineTotal;
    } else if (row.itemType === 'PART') {
      partsCost += lineTotal;
    }
  }

  laborCost = roundMoney(laborCost);
  partsCost = roundMoney(partsCost);
  const totalCostGEL = roundMoney(laborCost + partsCost);

  const costs = { totalCostGEL, currency: 'GEL' };
  await applyEurConversion(costs, warn);

  await UPDATE(ServiceOrders)
    .set({
      laborCost,
      partsCost,
      totalCostGEL,
      exchangeRate: costs.exchangeRate ?? null,
      totalCostEUR: costs.totalCostEUR ?? null,
    })
    .where({ ID: serviceOrderId });
}

async function validateMechanicAssignment(req, { ServiceOrders, Mechanics, mechanicId, excludeOrderId }) {
  const mechanic = await SELECT.one.from(Mechanics).where({ ID: mechanicId });
  if (!mechanic) {
    return req.reject(404, 'Mechanic not found.');
  }

  const conditions = {
    mechanic_ID: mechanicId,
    status: { in: ACTIVE_ORDER_STATUSES },
  };
  if (excludeOrderId) {
    conditions.ID = { '!=': excludeOrderId };
  }

  const conflicting = await SELECT.from(ServiceOrders).where(conditions);
  if (conflicting.length > 0) {
    return req.reject(409, 'Mechanic is already assigned to another active service order.');
  }

  if (mechanic.status === 'BUSY') {
    const inProgress = await SELECT.one.from(ServiceOrders).where({
      mechanic_ID: mechanicId,
      status: 'IN_PROGRESS',
      ...(excludeOrderId ? { ID: { '!=': excludeOrderId } } : {}),
    });
    if (inProgress) {
      return req.reject(400, 'Mechanic is marked BUSY and has an order in progress.');
    }
  }
}

async function syncMechanicStatus(Mechanics, ServiceOrders, mechanicId) {
  if (!mechanicId) {
    return;
  }

  const inProgress = await SELECT.one.from(ServiceOrders).where({
    mechanic_ID: mechanicId,
    status: 'IN_PROGRESS',
  });

  const nextStatus = inProgress ? 'BUSY' : 'AVAILABLE';
  const mechanic = await SELECT.one.from(Mechanics).where({ ID: mechanicId });
  if (mechanic && mechanic.status !== nextStatus) {
    await UPDATE(Mechanics).set({ status: nextStatus }).where({ ID: mechanicId });
  }
}

function orderNumberCountersEntity() {
  return cds.model.definitions['com.carservice.OrderNumberCounters'];
}

async function maxOrderSequenceForYear(ServiceOrders, year) {
  const prefix = `SO-${year}-`;
  const rows = await SELECT.from(ServiceOrders)
    .columns('orderNumber')
    .where({ orderNumber: { like: `${prefix}%` } });

  let maxSeq = 0;
  for (const row of rows) {
    const match = String(row.orderNumber).match(/SO-\d{4}-(\d+)$/);
    if (match) {
      maxSeq = Math.max(maxSeq, parseInt(match[1], 10));
    }
  }
  return maxSeq;
}

async function allocateOrderNumber(ServiceOrders) {
  const year = new Date().getUTCFullYear();
  const prefix = `SO-${year}-`;
  const Counters = orderNumberCountersEntity();

  for (let attempt = 0; attempt < ORDER_NUMBER_ALLOCATION_RETRIES; attempt++) {
    try {
      return await cds.tx(async () => {
        let counter = await SELECT.one.from(Counters).where({ year });
        if (!counter) {
          const seededMax = await maxOrderSequenceForYear(ServiceOrders, year);
          try {
            await INSERT.into(Counters).entries({ year, lastNumber: seededMax });
            counter = { year, lastNumber: seededMax };
          } catch (insertErr) {
            if (!isUniqueConstraintError(insertErr)) {
              throw insertErr;
            }
            counter = await SELECT.one.from(Counters).where({ year });
            if (!counter) {
              throw insertErr;
            }
          }
        }

        const nextSeq = counter.lastNumber + 1;
        await UPDATE(Counters).set({ lastNumber: nextSeq }).where({ year });
        return `${prefix}${String(nextSeq).padStart(4, '0')}`;
      });
    } catch (err) {
      if (isUniqueConstraintError(err) && attempt < ORDER_NUMBER_ALLOCATION_RETRIES - 1) {
        continue;
      }
      if (isUniqueConstraintError(err)) {
        const conflict = new Error(
          'Could not allocate a unique order number due to concurrent requests. Please retry.'
        );
        conflict.status = 409;
        throw conflict;
      }
      throw err;
    }
  }

  const conflict = new Error('Could not allocate a unique order number due to concurrent requests. Please retry.');
  conflict.status = 409;
  throw conflict;
}

function toDate(value) {
  if (!value) {
    return null;
  }
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function startOfToday() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

async function resolveForeignKey(req, idField, association) {
  if (req.data[idField]) {
    return req.data[idField];
  }
  if (association?.ID) {
    req.data[idField] = association.ID;
    return association.ID;
  }
  return null;
}

async function loadServiceOrderByRequest(req, ServiceOrders) {
  const keys = req.params?.length ? req.params[req.params.length - 1] : req.data;
  const ID = keys?.ID;
  if (!ID) {
    return req.reject(400, 'Service order key is missing.');
  }
  const order = await SELECT.one.from(ServiceOrders).where({ ID });
  if (!order) {
    return req.reject(404, 'Service order not found.');
  }
  return order;
}

async function resolveOrderIdFromItemRequest(req, ServiceItems) {
  const keys = req.params?.length ? req.params[req.params.length - 1] : req.data;
  const ID = keys?.ID;
  if (!ID) {
    return null;
  }
  const item = await SELECT.one.from(ServiceItems).where({ ID });
  return item?.serviceOrder_ID ?? null;
}

async function moveServiceOrder(req, ServiceOrders, Mechanics, { allowed, nextStatus, invalidStatus, prepare, after }) {
  const order = await loadServiceOrderByRequest(req, ServiceOrders);
  await assertMechanicOrderOwnership(req, order, Mechanics);

  if (!allowed.includes(order.status)) {
    return req.reject(400, invalidStatus(order.status));
  }
  if (prepare) {
    await prepare(order);
  }
  await UPDATE(ServiceOrders).set({ status: nextStatus }).where({ ID: order.ID });
  if (after) {
    await after(order);
  }
  return SELECT.one.from(ServiceOrders).where({ ID: order.ID });
}

function isUniqueConstraintError(err) {
  const message = String(err?.message || err?.original?.message || '');
  return (
    err?.code === 'SQLITE_CONSTRAINT' ||
    err?.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    /unique constraint failed/i.test(message)
  );
}

function translateDatabaseError(err, req) {
  if (!isUniqueConstraintError(err)) {
    return;
  }

  const message = String(err?.message || err?.original?.message || '');
  if (/orderNumber/i.test(message)) {
    req.error(
      409,
      'A service order with this order number already exists. Please retry creating the service order.'
    );
    return false;
  }

  req.error(409, 'The request conflicts with existing data.');
  return false;
}
