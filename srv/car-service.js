const cds = require('@sap/cds');
const { SELECT, UPDATE } = cds.ql;
const { applyEurConversion, roundMoney } = require('./lib/exchange-rates');

const ACTIVE_ORDER_STATUSES = ['OPEN', 'IN_PROGRESS'];
const TERMINAL_ORDER_STATUSES = ['COMPLETED', 'CANCELLED'];

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

    const itemTargets = [ServiceItems, ServiceItems.drafts].filter(Boolean);
    this.before(['CREATE', 'UPDATE', 'NEW'], itemTargets, this.onBeforeServiceItemSave);
    this.before(['DELETE', 'CANCEL'], itemTargets, this.onBeforeServiceItemDelete);
    this.after(['CREATE', 'UPDATE', 'DELETE', 'NEW', 'CANCEL'], itemTargets, this.onAfterServiceItemChange);

    this.on('startService', ServiceOrders, this.onStartService);
    this.on('completeService', ServiceOrders, this.onCompleteService);
    this.on('cancelService', ServiceOrders, this.onCancelService);
    this.on('refreshExchangeRate', ServiceOrders, this.onRefreshExchangeRate);
  }

  async onBeforeServiceOrderCreate(req) {
    const order = req.data;
    if (!order.orderNumber) {
      order.orderNumber = await generateOrderNumber(this.entities.ServiceOrders);
    }
    if (!order.status) {
      order.status = 'OPEN';
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
        req.error(404, 'Service order not found.');
      }
      if (order.status !== undefined && order.status !== existing.status) {
        req.error(400, 'Service order status cannot be changed directly. Use startService, completeService, or cancelService.');
      }
      delete order.status;

      if (TERMINAL_ORDER_STATUSES.includes(existing.status)) {
        req.error(400, `Cannot modify a ${existing.status} service order.`);
      }
    }

    if (isCreate && order.status && order.status !== 'OPEN') {
      req.error(400, 'New service orders must start in OPEN status. Use actions to change lifecycle.');
    }

    const serviceDate = toDate(order.serviceDate ?? existing?.serviceDate);
    if (!serviceDate) {
      req.error(400, 'Service date is required.');
    }
    if (isCreate && serviceDate < startOfToday()) {
      req.error(400, 'Service date cannot be in the past.');
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
      req.error(400, 'Customer and vehicle are required.');
    }

    const mileageAtService = order.mileageAtService ?? existing?.mileageAtService;
    if (mileageAtService === undefined || mileageAtService === null) {
      req.error(400, 'Mileage at service is required.');
    }

    const vehicle = await SELECT.one.from(Vehicles).where({ ID: vehicleId });
    if (!vehicle) {
      req.error(404, 'Vehicle not found.');
    }
    if (String(vehicle.customer_ID) !== String(customerId)) {
      req.error(400, 'Selected vehicle does not belong to the selected customer.');
    }
    if (Number(mileageAtService) < Number(vehicle.currentMileage)) {
      req.error(
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
        req.error(400, `Cannot change line items on a ${order.status} service order.`);
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

    // after DELETE the item row is already gone
    req.data.serviceOrder_ID = existing.serviceOrder_ID;

    const order = await SELECT.one.from(ServiceOrders).columns('status').where({ ID: existing.serviceOrder_ID });
    if (order && TERMINAL_ORDER_STATUSES.includes(order.status)) {
      req.error(400, `Cannot change line items on a ${order.status} service order.`);
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
    return moveServiceOrder(req, ServiceOrders, {
      allowed: ['OPEN'],
      nextStatus: 'IN_PROGRESS',
      invalidStatus: (status) => `Service order must be OPEN to start (current: ${status}).`,
      prepare: (order) => {
        if (!order.mechanic_ID) {
          req.error(400, 'Assign a mechanic before starting service.');
        }
      },
      after: (order) => syncMechanicStatus(Mechanics, ServiceOrders, order.mechanic_ID),
    });
  }

  async onCompleteService(req) {
    const { ServiceOrders, Vehicles, Mechanics } = this.entities;
    return moveServiceOrder(req, ServiceOrders, {
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
    return moveServiceOrder(req, ServiceOrders, {
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
      req.error(400, 'Cannot refresh exchange rate on a cancelled service order.');
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

function priceServiceItem(req, item) {
  const itemType = (item.itemType || '').toUpperCase();
  const pricing = ITEM_PRICING[itemType];
  if (!pricing) {
    if (!isDraftRequest(req)) {
      req.error(400, 'Item type must be LABOR or PART.');
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

  if (isDraftRequest(req)) {
    return;
  }
  if (!amountOk) {
    req.error(400, pricing.amountError);
  }
  if (!priceOk) {
    req.error(400, pricing.priceError);
  }
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
    req.error(404, 'Mechanic not found.');
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
    req.error(409, 'Mechanic is already assigned to another active service order.');
  }

  if (mechanic.status === 'BUSY') {
    const inProgress = await SELECT.one.from(ServiceOrders).where({
      mechanic_ID: mechanicId,
      status: 'IN_PROGRESS',
      ...(excludeOrderId ? { ID: { '!=': excludeOrderId } } : {}),
    });
    if (inProgress) {
      req.error(400, 'Mechanic is marked BUSY and has an order in progress.');
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

async function generateOrderNumber(ServiceOrders) {
  const year = new Date().getUTCFullYear();
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

  const next = String(maxSeq + 1).padStart(4, '0');
  return `${prefix}${next}`;
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
    req.error(400, 'Service order key is missing.');
  }
  const order = await SELECT.one.from(ServiceOrders).where({ ID });
  if (!order) {
    req.error(404, 'Service order not found.');
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

async function moveServiceOrder(req, ServiceOrders, { allowed, nextStatus, invalidStatus, prepare, after }) {
  const order = await loadServiceOrderByRequest(req, ServiceOrders);
  if (!allowed.includes(order.status)) {
    req.error(400, invalidStatus(order.status));
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
