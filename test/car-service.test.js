process.env.CDS_ENV = process.env.CDS_ENV || 'test';

const path = require('path');

const cds = require('@sap/cds');
const { GET, POST, expect } = cds.test(path.join(__dirname, '..'));

const ADVISOR = { auth: { username: 'advisor', password: 'advisor' } };

const CUSTOMER_SABA = '11111111-1111-1111-1111-111111111101';
const CUSTOMER_GIORGI = '11111111-1111-1111-1111-111111111102';
const VEHICLE_JETTA = '22222222-2222-2222-2222-222222222201';
const VEHICLE_BMW = '22222222-2222-2222-2222-222222222202';
const COMPLETED_ORDER = '33333333-3333-3333-3333-333333333303';
const COMPLETED_VEHICLE = '22222222-2222-2222-2222-222222222203';

function tomorrowIsoDate() {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function newOrderPayload(customerId, vehicleId, mileageAtService) {
  return {
    customer_ID: customerId,
    vehicle_ID: vehicleId,
    serviceDate: tomorrowIsoDate(),
    mileageAtService,
  };
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

    const draft = await POST('/odata/v4/CarService/ServiceOrders', body, ADVISOR);
    expect(draft.status).to.equal(201);
    expect(draft.data.customer_ID).to.equal(CUSTOMER_SABA);
    expect(draft.data.vehicle_ID).to.equal(VEHICLE_JETTA);
    expect(draft.data.IsActiveEntity).to.equal(false);

    const orderId = draft.data.ID;
    const active = await POST(
      `/odata/v4/CarService/ServiceOrders(ID=${orderId},IsActiveEntity=false)/CarServiceService.draftActivate`,
      {},
      ADVISOR
    );
    expect(active.status).to.be.oneOf([200, 201]);
    expect(active.data.status).to.equal('OPEN');
    expect(String(active.data.orderNumber)).to.match(/^SO-\d{4}-\d{4}$/);
  });

  it('rejects a vehicle that does not belong to the selected customer', async () => {
    const body = newOrderPayload(CUSTOMER_SABA, VEHICLE_BMW, 89500);

    await expect(POST('/odata/v4/CarService/ServiceOrders', body, ADVISOR)).to.be.rejectedWith(
      /does not belong to the selected customer/i
    );
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
