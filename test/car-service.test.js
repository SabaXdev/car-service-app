process.env.CDS_ENV = process.env.CDS_ENV || 'test';

const path = require('path');

const cds = require('@sap/cds');
const { GET, POST, expect } = cds.test(path.join(__dirname, '..'));

const ADVISOR = { auth: { username: 'advisor', password: 'advisor' } };
const MECHANIC = { auth: { username: 'mechanic1', password: 'mechanic' } };

const CUSTOMER_SABA = '11111111-1111-1111-1111-111111111101';
const CUSTOMER_GIORGI = '11111111-1111-1111-1111-111111111102';
const VEHICLE_JETTA = '22222222-2222-2222-2222-222222222201';
const VEHICLE_BMW = '22222222-2222-2222-2222-222222222202';
const MECHANIC_ANA = '44444444-4444-4444-4444-444444444402';
const COMPLETED_ORDER = '33333333-3333-3333-3333-333333333303';
const COMPLETED_VEHICLE = '22222222-2222-2222-2222-222222222203';
const OPEN_ORDER_OTHER_MECHANIC = '33333333-3333-3333-3333-333333333302';
const IN_PROGRESS_ORDER_ANA = '33333333-3333-3333-3333-333333333301';

function tomorrowIsoDate() {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function newOrderPayload(customerId, vehicleId, mileageAtService, extra = {}) {
  return {
    customer_ID: customerId,
    vehicle_ID: vehicleId,
    serviceDate: tomorrowIsoDate(),
    mileageAtService,
    ...extra,
  };
}

async function createDraftOrder(payload, auth = ADVISOR) {
  const draft = await POST('/odata/v4/CarService/ServiceOrders', payload, auth);
  expect(draft.status).to.equal(201);
  return draft.data;
}

async function activateDraftOrder(orderId, auth = ADVISOR) {
  const active = await POST(
    `/odata/v4/CarService/ServiceOrders(ID=${orderId},IsActiveEntity=false)/CarServiceService.draftActivate`,
    {},
    auth
  );
  expect(active.status).to.be.oneOf([200, 201]);
  return active.data;
}

async function createActiveOrder(payload, auth = ADVISOR) {
  const draft = await createDraftOrder(payload, auth);
  return activateDraftOrder(draft.ID, auth);
}

async function addDraftItem(orderId, item, auth = ADVISOR) {
  const response = await POST(
    `/odata/v4/CarService/ServiceOrders(ID=${orderId},IsActiveEntity=false)/items`,
    item,
    auth
  );
  expect(response.status).to.equal(201);
  return response.data;
}

describe('CarService smoke tests', () => {
  it('serves OData metadata for authenticated users', async () => {
    const response = await GET('/odata/v4/CarService/$metadata', {
      ...ADVISOR,
      headers: { accept: 'application/xml' },
      responseType: 'text',
    });
    expect(response.status).to.equal(200);
    expect(String(response.data)).to.include('ServiceOrders');
    expect(String(response.data)).to.include('CarServiceService');
  });

  it('rejects unauthenticated access to ServiceOrders', async () => {
    await expect(GET('/odata/v4/CarService/ServiceOrders')).to.be.rejectedWith(/401/);
  });

  it('creates a service order as ServiceAdvisor', async () => {
    const body = newOrderPayload(CUSTOMER_SABA, VEHICLE_JETTA, 125800);

    const draft = await createDraftOrder(body);
    expect(draft.customer_ID).to.equal(CUSTOMER_SABA);
    expect(draft.vehicle_ID).to.equal(VEHICLE_JETTA);
    expect(draft.IsActiveEntity).to.equal(false);

    const active = await activateDraftOrder(draft.ID);
    expect(active.status).to.equal('OPEN');
    expect(String(active.orderNumber)).to.match(/^SO-\d{4}-\d{4}$/);
  });

  it('rejects a vehicle that does not belong to the selected customer', async () => {
    const body = newOrderPayload(CUSTOMER_SABA, VEHICLE_BMW, 89500);

    await expect(POST('/odata/v4/CarService/ServiceOrders', body, ADVISOR)).to.be.rejectedWith(
      /does not belong to the selected customer/i
    );
  });

  it('rejects startService by a mechanic on another mechanic\'s order', async () => {
    await expect(
      POST(
        `/odata/v4/CarService/ServiceOrders(ID=${OPEN_ORDER_OTHER_MECHANIC},IsActiveEntity=true)/CarServiceService.startService`,
        {},
        MECHANIC
      )
    ).to.be.rejectedWith(/assigned to you/i);
  });

  it('rejects draft activation when a line item has invalid pricing', async () => {
    const draft = await createDraftOrder(newOrderPayload(CUSTOMER_SABA, VEHICLE_JETTA, 125800));
    await addDraftItem(draft.ID, {
      description: 'Invalid labor line',
      itemType: 'LABOR',
      hours: 0,
      hourlyRate: 50,
    });

    await expect(activateDraftOrder(draft.ID)).to.be.rejectedWith(/hours greater than zero/i);
  });

  it('keeps completed-order mileage aligned with vehicle current mileage in seed data', async () => {
    const { data: order } = await GET(
      `/odata/v4/CarService/ServiceOrders(ID=${COMPLETED_ORDER},IsActiveEntity=true)?$select=status,mileageAtService`,
      ADVISOR
    );
    const { data: vehicle } = await GET(
      `/odata/v4/CarService/Vehicles(ID=${COMPLETED_VEHICLE})?$select=currentMileage`,
      ADVISOR
    );

    expect(order.status).to.equal('COMPLETED');
    expect(Number(vehicle.currentMileage)).to.equal(Number(order.mileageAtService));
    expect(Number(order.mileageAtService)).to.equal(45200);
  });
});

describe('Reviewer feedback coverage', () => {
  it('rejects completeService by a mechanic on another mechanic\'s order', async () => {
    await expect(
      POST(
        `/odata/v4/CarService/ServiceOrders(ID=${OPEN_ORDER_OTHER_MECHANIC},IsActiveEntity=true)/CarServiceService.completeService`,
        {},
        MECHANIC
      )
    ).to.be.rejectedWith(/assigned to you/i);
  });

  it('allows advisor to startService on an OPEN order assigned to any mechanic', async () => {
    const response = await POST(
      `/odata/v4/CarService/ServiceOrders(ID=${OPEN_ORDER_OTHER_MECHANIC},IsActiveEntity=true)/CarServiceService.startService`,
      {},
      ADVISOR
    );
    expect(response.status).to.be.oneOf([200, 201]);
    expect(response.data.status).to.equal('IN_PROGRESS');
  });

  it('runs startService and completeService for the assigned mechanic on a dedicated order', async () => {
    await POST(
      `/odata/v4/CarService/ServiceOrders(ID=${IN_PROGRESS_ORDER_ANA},IsActiveEntity=true)/CarServiceService.cancelService`,
      {},
      ADVISOR
    );

    const order = await createActiveOrder(
      newOrderPayload(CUSTOMER_SABA, VEHICLE_JETTA, 125850, { mechanic_ID: MECHANIC_ANA })
    );
    expect(order.status).to.equal('OPEN');

    const started = await POST(
      `/odata/v4/CarService/ServiceOrders(ID=${order.ID},IsActiveEntity=true)/CarServiceService.startService`,
      {},
      MECHANIC
    );
    expect(started.status).to.be.oneOf([200, 201]);
    expect(started.data.status).to.equal('IN_PROGRESS');

    const completed = await POST(
      `/odata/v4/CarService/ServiceOrders(ID=${order.ID},IsActiveEntity=true)/CarServiceService.completeService`,
      {},
      MECHANIC
    );
    expect(completed.status).to.be.oneOf([200, 201]);
    expect(completed.data.status).to.equal('COMPLETED');

    const { data: vehicle } = await GET(
      `/odata/v4/CarService/Vehicles(ID=${VEHICLE_JETTA})?$select=currentMileage`,
      ADVISOR
    );
    expect(Number(vehicle.currentMileage)).to.equal(125850);
  });

  it('rejects draft activation for PART with quantity zero', async () => {
    const draft = await createDraftOrder(newOrderPayload(CUSTOMER_SABA, VEHICLE_JETTA, 125900));
    await addDraftItem(draft.ID, {
      description: 'Bad part line',
      itemType: 'PART',
      quantity: 0,
      partPrice: 10,
    });

    await expect(activateDraftOrder(draft.ID)).to.be.rejectedWith(/quantity greater than zero/i);
  });

  it('rejects draft activation for negative part price', async () => {
    const draft = await createDraftOrder(newOrderPayload(CUSTOMER_SABA, VEHICLE_JETTA, 125900));
    await addDraftItem(draft.ID, {
      description: 'Negative price',
      itemType: 'PART',
      quantity: 1,
      partPrice: -5,
    });

    await expect(activateDraftOrder(draft.ID)).to.be.rejectedWith(/valid part price/i);
  });

  it('rejects draft activation for LABOR with a negative hourly rate', async () => {
    const draft = await createDraftOrder(newOrderPayload(CUSTOMER_SABA, VEHICLE_JETTA, 125900));
    await addDraftItem(draft.ID, {
      description: 'Labor negative rate',
      itemType: 'LABOR',
      hours: 2,
      hourlyRate: -10,
    });

    await expect(activateDraftOrder(draft.ID)).to.be.rejectedWith(/valid hourly rate/i);
  });

  it('assigns unique order numbers across sequential creates', async () => {
    const first = await createActiveOrder(newOrderPayload(CUSTOMER_GIORGI, VEHICLE_BMW, 89500));
    const second = await createActiveOrder(newOrderPayload(CUSTOMER_GIORGI, VEHICLE_BMW, 89510));

    expect(first.orderNumber).to.not.equal(second.orderNumber);
    expect(first.orderNumber).to.match(/^SO-\d{4}-\d{4}$/);
    expect(second.orderNumber).to.match(/^SO-\d{4}-\d{4}$/);
  });

  it('assigns unique order numbers under parallel draft creates', async () => {
    const payloads = Array.from({ length: 5 }, (_, index) =>
      newOrderPayload(CUSTOMER_GIORGI, VEHICLE_BMW, 89520 + index)
    );

    const drafts = await Promise.all(
      payloads.map((body) => POST('/odata/v4/CarService/ServiceOrders', body, ADVISOR))
    );
    for (const draft of drafts) {
      expect(draft.status).to.equal(201);
    }

    const activated = await Promise.all(
      drafts.map((draft) =>
        POST(
          `/odata/v4/CarService/ServiceOrders(ID=${draft.data.ID},IsActiveEntity=false)/CarServiceService.draftActivate`,
          {},
          ADVISOR
        )
      )
    );

    const orderNumbers = activated.map((response) => {
      expect(response.status).to.be.oneOf([200, 201]);
      return response.data.orderNumber;
    });

    expect(new Set(orderNumbers).size).to.equal(orderNumbers.length);
  });
});
