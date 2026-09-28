using com.carservice as db from '../db/schema';

@path: 'CarService'
@protocol: 'odata-v4'
@requires: 'authenticated-user'
@impl: './car-service.js'
service CarServiceService {

  entity Customers    as projection on db.Customers;
  entity Vehicles     as projection on db.Vehicles;
  entity Mechanics    as projection on db.Mechanics;
  entity ServiceItems as projection on db.ServiceItems;

  @odata.draft.enabled
  entity ServiceOrders as projection on db.ServiceOrders {
    *,
    customer,
    vehicle,
    mechanic,
    items,
  } actions {
    action startService()            returns ServiceOrders;
    action completeService()         returns ServiceOrders;
    action cancelService()           returns ServiceOrders;
    action refreshExchangeRate()     returns ServiceOrders;
  };
}

annotate CarServiceService.Customers with @restrict: [
  { grant: ['READ', 'CREATE', 'UPDATE', 'DELETE'], to: 'ServiceAdvisor' },
  { grant: ['READ'], to: 'Mechanic' },
  { grant: '*', to: 'Admin' }
];

annotate CarServiceService.Vehicles with @restrict: [
  { grant: ['READ', 'CREATE', 'UPDATE', 'DELETE'], to: 'ServiceAdvisor' },
  { grant: ['READ'], to: 'Mechanic' },
  { grant: '*', to: 'Admin' }
];

annotate CarServiceService.Mechanics with @restrict: [
  { grant: ['READ'], to: ['ServiceAdvisor', 'Mechanic'] },
  { grant: '*', to: 'Admin' }
];

annotate CarServiceService.ServiceItems with @restrict: [
  { grant: ['READ', 'CREATE', 'UPDATE', 'DELETE'], to: 'ServiceAdvisor' },
  { grant: ['READ'], to: 'Mechanic' },
  { grant: '*', to: 'Admin' }
];

annotate CarServiceService.ServiceOrders with @restrict: [
  { grant: ['READ', 'CREATE', 'UPDATE', 'DELETE'], to: 'ServiceAdvisor' },
  {
    grant: ['READ'],
    to: 'Mechanic',
    where: 'mechanic.authUser = $user.id'
  },
  { grant: '*', to: 'Admin' },
  { grant: 'startService', to: ['Admin', 'ServiceAdvisor', 'Mechanic'] },
  { grant: 'completeService', to: ['Admin', 'ServiceAdvisor', 'Mechanic'] },
  { grant: 'cancelService', to: ['Admin', 'ServiceAdvisor'] },
  { grant: 'refreshExchangeRate', to: ['Admin', 'ServiceAdvisor'] }
];

annotate CarServiceService.ServiceOrders with {
  laborCost     @readonly;
  partsCost     @readonly;
  totalCostGEL  @readonly;
  totalCostEUR  @readonly;
  exchangeRate  @readonly;
};

annotate CarServiceService.ServiceItems with {
  lineTotal @readonly;
};

annotate CarServiceService.ServiceOrders with {
  items @Common.SideEffects: {
    TargetProperties: [
      'laborCost',
      'partsCost',
      'totalCostGEL',
      'totalCostEUR',
      'exchangeRate'
    ]
  };
};
